import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonSlurper
import groovy.json.JsonOutput

def Message processData(Message message) {
    def json = new JsonSlurper().parse(message.getBody(java.io.Reader.class))
    def d = json?.d
    def items = (d instanceof Map) ? (d.results ?: []) : (d instanceof List ? d : (json?.value ?: []))
    def products = items
        .findAll { it != null && it.UnitPrice != null && new BigDecimal(it.UnitPrice.toString()) > 20 }
        .collect { [id: it.ProductID, name: it.ProductName, price: new BigDecimal(it.UnitPrice.toString())] }
    message.setBody(JsonOutput.toJson([products: products]))
    return message
}
