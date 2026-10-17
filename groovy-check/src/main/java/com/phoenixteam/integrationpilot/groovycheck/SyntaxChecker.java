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

    public static List<Error> check(String fileName, String code) {
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
