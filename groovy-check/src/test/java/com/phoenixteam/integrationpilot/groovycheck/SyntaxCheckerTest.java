package com.phoenixteam.integrationpilot.groovycheck;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import org.junit.jupiter.api.Test;

class SyntaxCheckerTest {

    static final String VALID = """
            import com.sap.gateway.ip.core.customdev.util.Message
            import com.sap.it.api.ITApiFactory

            def Message processData(Message message) {
                def body = message.getBody(String) ?: ''
                message.setHeader('X-Length', "${body.length()}")
                return message
            }
            """;

    @Test
    void validScriptWithUnknownSapClassesPasses() {
        // SAP classes are not on the classpath: CONVERSION does not resolve them
        assertEquals(List.of(), SyntaxChecker.check("ok.groovy", VALID));
    }

    @Test
    void missingBraceIsReportedWithLineAndColumn() {
        String broken = """
                import com.sap.gateway.ip.core.customdev.util.Message

                def Message processData(Message message) {
                    if (message) {
                        message.setHeader('A', 'b')
                    return message
                }
                """;
        List<SyntaxChecker.Error> errors = SyntaxChecker.check("broken.groovy", broken);
        assertEquals(1, errors.size());
        assertTrue(errors.get(0).line() > 0, "line is set");
        assertTrue(errors.get(0).column() > 0, "column is set");
        assertTrue(errors.get(0).message().length() > 0);
    }

    @Test
    void badStringEscapeIsReported() {
        List<SyntaxChecker.Error> errors = SyntaxChecker.check("escape.groovy", "def x = \"a\\qb\"\n");
        assertEquals(1, errors.size());
        assertEquals(1, errors.get(0).line());
    }

    @Test
    void grabIsNotProcessed() {
        // would download from Maven Central if the Grab transformation ran
        String grab = "@Grab('org.example:does-not-exist:1.0')\nimport org.example.Nothing\nprintln 'x'\n";
        assertEquals(List.of(), SyntaxChecker.check("grab.groovy", grab));
    }
}
