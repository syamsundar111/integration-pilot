package com.phoenixteam.integrationpilot.groovycheck;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import groovy.json.JsonOutput;
import groovy.json.JsonSlurper;

/**
 * HTTP API of the Groovy syntax check:
 *
 * GET  /health -> {"status":"UP"}
 * POST /check  {"scripts":[{"fileName":"mapUsers.groovy","code":"..."}]}
 *           -> {"results":[{"fileName":"mapUsers.groovy","errors":[{"line":3,"column":5,"message":"..."}]}]}
 *
 * Environment: PORT (default 4010), CHECK_TOKEN (if set, POST /check needs the header
 * x-check-token with this value).
 */
public final class Server {

    static final int MAX_BODY_BYTES = 2 * 1024 * 1024;
    static final int MAX_SCRIPTS = 50;
    static final int MAX_SCRIPT_CHARS = 300_000;
    static final long TIMEOUT_SECONDS = 10;

    private static final ExecutorService WORKERS = Executors.newFixedThreadPool(2);

    private Server() {
    }

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "4010"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/health", (ex) -> send(ex, 200, Map.of("status", "UP")));
        server.createContext("/check", Server::check);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("groovy-check listening on port " + port);
    }

    static void check(HttpExchange ex) throws IOException {
        try {
            if (!"POST".equals(ex.getRequestMethod())) {
                send(ex, 405, Map.of("error", "use POST"));
                return;
            }
            String token = System.getenv("CHECK_TOKEN");
            if (token != null && !token.isEmpty() && !sameToken(token, ex.getRequestHeaders().getFirst("x-check-token"))) {
                send(ex, 401, Map.of("error", "missing or wrong x-check-token"));
                return;
            }
            byte[] body = readBody(ex.getRequestBody());
            if (body == null) {
                send(ex, 413, Map.of("error", "request larger than " + MAX_BODY_BYTES + " bytes"));
                return;
            }
            Object parsed = new JsonSlurper().parseText(new String(body, StandardCharsets.UTF_8));
            Object scripts = parsed instanceof Map<?, ?> m ? m.get("scripts") : null;
            if (!(scripts instanceof List<?> list) || list.size() > MAX_SCRIPTS) {
                send(ex, 400, Map.of("error", "expected {\"scripts\":[{\"fileName\",\"code\"}]} with at most " + MAX_SCRIPTS + " scripts"));
                return;
            }
            List<Map<String, Object>> results = new ArrayList<>();
            for (Object s : list) {
                Map<?, ?> script = s instanceof Map<?, ?> sm ? sm : Map.of();
                String fileName = String.valueOf(script.get("fileName"));
                Object code = script.get("code");
                if (!(code instanceof String c) || c.length() > MAX_SCRIPT_CHARS) {
                    send(ex, 400, Map.of("error", fileName + ": code missing or longer than " + MAX_SCRIPT_CHARS + " characters"));
                    return;
                }
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("fileName", fileName);
                result.put("errors", checkWithTimeout(fileName, c));
                results.add(result);
            }
            send(ex, 200, Map.of("results", results));
        } catch (Exception e) {
            send(ex, 400, Map.of("error", String.valueOf(e.getMessage())));
        }
    }

    static List<Map<String, Object>> checkWithTimeout(String fileName, String code) throws Exception {
        Future<List<SyntaxChecker.Error>> f = WORKERS.submit(() -> SyntaxChecker.check(fileName, code));
        try {
            return f.get(TIMEOUT_SECONDS, TimeUnit.SECONDS).stream().map(SyntaxChecker.Error::toMap).toList();
        } catch (TimeoutException e) {
            f.cancel(true);
            return List.of(Map.of("line", 0, "column", 0, "message", "parsing took longer than " + TIMEOUT_SECONDS + "s"));
        }
    }

    static boolean sameToken(String expected, String given) {
        return given != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), given.getBytes(StandardCharsets.UTF_8));
    }

    static byte[] readBody(InputStream in) throws IOException {
        byte[] bytes = in.readNBytes(MAX_BODY_BYTES + 1);
        return bytes.length > MAX_BODY_BYTES ? null : bytes;
    }

    static void send(HttpExchange ex, int status, Object body) throws IOException {
        byte[] out = JsonOutput.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json");
        ex.sendResponseHeaders(status, out.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(out);
        }
    }
}
