package com.phoenixteam.integrationpilot.groovycheck;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
 * Parse-only syntax check of a Groovy script: compiles up to the CONVERSION phase (source to
 * AST), so no SAP classes are needed and nothing is resolved, generated or executed. @Grab is
 * disabled, so a script cannot make the checker download anything.
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

    private static Error toError(Message m) {
        if (m instanceof SyntaxErrorMessage s) {
            SyntaxException e = s.getCause();
            return new Error(e.getStartLine(), e.getStartColumn(), e.getOriginalMessage());
        }
        if (m instanceof ExceptionMessage x) return new Error(0, 0, String.valueOf(x.getCause().getMessage()));
        return new Error(0, 0, m.toString());
    }
}
