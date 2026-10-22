package com.phoenixteam.integrationpilot.groovycheck;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.codehaus.groovy.control.CompilationFailedException;
import org.codehaus.groovy.control.CompilationUnit;
import org.codehaus.groovy.control.CompilerConfiguration;
import org.codehaus.groovy.control.MultipleCompilationErrorsException;
import org.codehaus.groovy.control.Phases;
import org.codehaus.groovy.control.messages.ExceptionMessage;
import org.codehaus.groovy.control.messages.Message;
import org.codehaus.groovy.control.messages.SyntaxErrorMessage;
import org.codehaus.groovy.syntax.SyntaxException;

/**
 * Syntax check of a Groovy script. First a parse (CONVERSION phase: source to AST); if that passes,
 * a second compile up to SEMANTIC_ANALYSIS resolves the imports and class names against stub
 * classes of the CPI script API (com.sap.gateway..., com.sap.it.api..., in this module). Nothing is
 * generated or executed, and @Grab is disabled, so a script cannot make the checker download anything.
 *
 * Only unresolved classes in the CPI API packages the stubs cover completely are reported (e.g. the
 * non-existent com.sap.gateway.ip.core.customdev.util.MessageLogFactory, which fails at runtime with
 * "unable to resolve class"). Other unresolved imports (Camel, classes of other Groovy versions,
 * libraries of the tenant) are not reported, so correct scripts are never blocked by a missing stub.
 */
public final class SyntaxChecker {

    /** One syntax error; line and column are 1-based, 0 when unknown */
    public record Error(int line, int column, String message) {
        Map<String, Object> toMap() {
            return Map.of("line", line, "column", column, "message", message);
        }
    }

    private SyntaxChecker() {
    }

    static final int MAX_LOCATE_LINES = 600;
    static final long LOCATE_BUDGET_MS = 3000;

    /**
     * Syntax errors of a script. The Groovy parser often reports an error inside a closure or
     * block as "Unexpected input" at the block's opening brace; then the line whose removal makes
     * the script parse is named in the message ("probably at line N: ...").
     */
    public static List<Error> check(String fileName, String code) {
        List<Error> errors = parse(fileName, code);
        if (errors.isEmpty()) return resolve(fileName, code);
        if (errors.size() == 1 && errors.get(0).message().startsWith("Unexpected input")) {
            Integer culprit = locate(fileName, code);
            Error e = errors.get(0);
            if (culprit != null && culprit != e.line()) {
                String text = code.split("\n", -1)[culprit - 1].trim();
                if (text.length() > 80) text = text.substring(0, 77) + "...";
                return List.of(new Error(culprit, 1, e.message() + " (reported at line " + e.line() + ":" + e.column() + "; the problem is probably at line " + culprit + ": " + text + ")"));
            }
        }
        return errors;
    }

    /** The single line whose removal makes the script parse, or null */
    static Integer locate(String fileName, String code) {
        String[] lines = code.split("\n", -1);
        if (lines.length > MAX_LOCATE_LINES) return null;
        long deadline = System.currentTimeMillis() + LOCATE_BUDGET_MS;
        Integer found = null;
        for (int i = 0; i < lines.length; i++) {
            if (System.currentTimeMillis() > deadline) return null;
            if (lines[i].isBlank()) continue;
            String[] copy = lines.clone();
            copy[i] = "";
            if (parse(fileName, String.join("\n", copy)).isEmpty()) {
                if (found != null) return null; // more than one candidate: no reliable answer
                found = i + 1;
            }
        }
        return found;
    }

    private static List<Error> parse(String fileName, String code) {
        CompilerConfiguration config = new CompilerConfiguration();
        config.setDisabledGlobalASTTransformations(Set.of("groovy.grape.GrabAnnotationTransformation"));
        config.setTolerance(10); // report up to 10 errors per script instead of stopping at the first
        CompilationUnit unit = new CompilationUnit(config);
        unit.addSource(fileName, code);
        List<Error> errors = new ArrayList<>();
        try {
            unit.compile(Phases.CONVERSION);
        } catch (MultipleCompilationErrorsException e) {
            for (Message m : e.getErrorCollector().getErrors()) errors.add(toError(m));
        } catch (CompilationFailedException e) {
            errors.add(new Error(0, 0, e.getMessage()));
        }
        return errors;
    }

    /** CPI API packages whose classes all have stubs: an unknown class there does not exist on CPI */
    static final Set<String> STRICT_PACKAGES = Set.of("com.sap.gateway.ip.core.customdev.util", "com.sap.it.api.msglog");
    private static final Pattern UNRESOLVED = Pattern.compile("unable to resolve class ([A-Za-z_$][\\w$.]*)");

    /** Unresolved classes of the strict CPI packages, after compiling up to semantic analysis */
    static List<Error> resolve(String fileName, String code) {
        CompilerConfiguration config = new CompilerConfiguration();
        config.setDisabledGlobalASTTransformations(Set.of("groovy.grape.GrabAnnotationTransformation"));
        config.setTolerance(10);
        // resolve classes through the class loader, not by reading class files with ASM: Groovy's ASM
        // cannot read the class files of newer JDKs ("Unsupported class file major version 69" on Java 25)
        config.getOptimizationOptions().put("asmResolving", false);
        CompilationUnit unit = new CompilationUnit(config, null, new groovy.lang.GroovyClassLoader(SyntaxChecker.class.getClassLoader(), config));
        unit.addSource(fileName, code);
        List<Error> errors = new ArrayList<>();
        try {
            unit.compile(Phases.SEMANTIC_ANALYSIS);
        } catch (MultipleCompilationErrorsException e) {
            for (Message m : e.getErrorCollector().getErrors()) {
                Error err = toError(m);
                Matcher u = UNRESOLVED.matcher(err.message());
                if (!u.find()) continue;
                String cls = u.group(1);
                int dot = cls.lastIndexOf('.');
                if (dot < 0 || !STRICT_PACKAGES.contains(cls.substring(0, dot))) continue;
                String hint = cls.endsWith(".MessageLogFactory") && !cls.startsWith("com.sap.it.api.msglog.")
                    ? " (no such class on CPI: messageLogFactory is a binding variable, use messageLogFactory.getMessageLog(message) without an import)"
                    : " (no such class in the CPI script API)";
                errors.add(new Error(err.line(), err.column(), "unable to resolve class " + cls + hint));
            }
        } catch (CompilationFailedException e) {
            // other failures are not import problems; the parse already passed
        } catch (RuntimeException | LinkageError | AssertionError e) {
            // a compiler failure (GroovyBugError, a class that cannot be loaded): the import check is
            // skipped for this script instead of failing the whole check; the parse already passed
            return List.of();
        }
        return errors;
    }

    private static Error toError(Message m) {
        if (m instanceof SyntaxErrorMessage s) {
            SyntaxException e = s.getCause();
            return new Error(e.getStartLine(), e.getStartColumn(), e.getOriginalMessage());
        }
        if (m instanceof ExceptionMessage x) return new Error(0, 0, String.valueOf(x.getCause().getMessage()));
        return new Error(0, 0, m.toString());
    }
}
