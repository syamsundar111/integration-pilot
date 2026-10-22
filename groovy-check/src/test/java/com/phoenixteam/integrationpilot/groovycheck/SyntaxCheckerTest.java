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

    @Test
    void errorInsideAClosureNamesTheLineThatCausesIt() {
        // as written by a model: quotes escaped twice inside nested closures; the parser reports the outer closure's brace
        String code = String.join("\n",
                "import com.sap.gateway.ip.core.customdev.util.Message",
                "def Message processData(Message message) {",
                "    def users = []",
                "    users.each { user ->",
                "        def toIso = { raw ->",
                "            def date = new Date(1L)",
                "            return date.format('yyyy-MM-dd\\\\'T\\\\'HH:mm:ss\\\\'Z\\\\', TimeZone.getTimeZone('UTC'))",
                "        }",
                "        def iso = toIso(user)",
                "    }",
                "    return message",
                "}",
                "");
        List<SyntaxChecker.Error> errors = SyntaxChecker.check("model.groovy", code);
        assertEquals(1, errors.size());
        assertEquals(7, errors.get(0).line());
        assertTrue(errors.get(0).message().startsWith("Unexpected input: '{' (reported at line 4:16; the problem is probably at line 7: return date.format("), errors.get(0).message());
    }

    @Test
    void messageLogFactoryImportFromTheWrongPackageIsReported() {
        // Test 16: CPI failed at runtime with "unable to resolve class" (HTTP 500)
        String script = """
                import com.sap.gateway.ip.core.customdev.util.Message
                import com.sap.gateway.ip.core.customdev.util.MessageLogFactory

                def Message processData(Message message) {
                    MessageLogFactory.getMessageLog().addAttachmentAsString("Notification", "x", "text/plain")
                    return message
                }
                """;
        List<SyntaxChecker.Error> errors = SyntaxChecker.check("addNotificationAttachment.groovy", script);
        assertEquals(1, errors.size());
        assertEquals(2, errors.get(0).line());
        assertEquals(1, errors.get(0).column());
        assertTrue(errors.get(0).message().startsWith("unable to resolve class com.sap.gateway.ip.core.customdev.util.MessageLogFactory (no such class on CPI: messageLogFactory is a binding variable"), errors.get(0).message());
    }

    @Test
    void correctCpiImportsAndTheBindingVariablePass() {
        String script = """
                import com.sap.gateway.ip.core.customdev.util.Message
                import com.sap.gateway.ip.core.customdev.util.*
                import com.sap.it.api.ITApiFactory
                import com.sap.it.api.msglog.MessageLog
                import com.sap.it.api.msglog.MessageLogFactory

                def Message processData(Message message) {
                    MessageLog log = messageLogFactory.getMessageLog(message)
                    log?.addAttachmentAsString("Notification", message.getBody(String) ?: "", "text/plain")
                    return message
                }
                """;
        assertEquals(List.of(), SyntaxChecker.check("ok.groovy", script));
    }

    @Test
    void unknownClassesInTheStrictCpiPackagesAreReported() {
        String script = "import com.sap.it.api.msglog.MessageLogger\nimport com.sap.gateway.ip.core.customdev.util.Messages\nprintln 'x'\n";
        List<SyntaxChecker.Error> errors = SyntaxChecker.check("typo.groovy", script);
        assertEquals(2, errors.size());
        assertTrue(errors.get(0).message().contains("com.sap.it.api.msglog.MessageLogger (no such class in the CPI script API)"), errors.get(0).message());
        assertEquals(2, errors.get(1).line());
    }

    @Test
    void importsOutsideTheStrictPackagesAreNotReported() {
        // Camel, classes of other Groovy versions and other SAP packages are not stubbed: never a false error
        String script = "import org.apache.camel.Exchange\nimport groovy.util.XmlSlurper\nimport com.sap.it.api.mapping.ValueMappingApi\nimport com.sap.it.api.securestore.SecureStoreService\nprintln 'x'\n";
        assertEquals(List.of(), SyntaxChecker.check("other.groovy", script));
    }
}

