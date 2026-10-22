package com.phoenixteam.integrationpilot.groovycheck;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.nio.file.Files;
import java.nio.file.Path;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import groovy.lang.Closure;
import groovy.lang.GroovyShell;
import org.codehaus.groovy.control.CompilerConfiguration;

/**
 * Runs the OData example of the odata pattern (test/fixtures/odata/filterProducts.groovy, as it ran on
 * CPI) with a fake Message: V2 d.results, V2 d as a list and V4 value, with a null item, a missing
 * price and V2 decimals as strings. Only this test executes a script; the checker never does.
 */
class OdataFixtureTest {

    static final String HARNESS = """

            class FakeMessage implements com.sap.gateway.ip.core.customdev.util.Message {
                Object body
                def getBody(Class type) { type == java.io.Reader ? new StringReader(body.toString()) : body }
                void setBody(Object b) { body = b }
            }
            return { String json -> def m = new FakeMessage(body: json); processData(m); m.body }
            """;

    static final String ITEMS = "[{\"ProductID\":1,\"ProductName\":\"Chai\",\"UnitPrice\":\"18.0000\"},null,"
            + "{\"ProductID\":2,\"ProductName\":\"Ikura\",\"UnitPrice\":\"31.0000\"},{\"ProductID\":3,\"ProductName\":\"NoPrice\"}]";
    static final String EXPECTED = "{\"products\":[{\"id\":2,\"name\":\"Ikura\",\"price\":31.0000}]}";

    @ParameterizedTest
    @CsvSource(delimiter = '|', value = { "V2 d.results|{\"d\":{\"results\":ITEMS}}", "V2 d list|{\"d\":ITEMS}", "V4 value|{\"value\":ITEMS}" })
    @SuppressWarnings("unchecked")
    void filtersProductsAbove20(String shape, String template) throws Exception {
        String script = Files.readString(Path.of("../test/fixtures/odata/filterProducts.groovy"));
        CompilerConfiguration config = new CompilerConfiguration();
        config.getOptimizationOptions().put("asmResolving", false); // Groovy 4.0.24 cannot read Java 25 class files with ASM
        Closure<Object> run = (Closure<Object>) new GroovyShell(config).evaluate(script + HARNESS);
        assertEquals(EXPECTED, run.call(template.replace("ITEMS", ITEMS)), shape);
    }
}
