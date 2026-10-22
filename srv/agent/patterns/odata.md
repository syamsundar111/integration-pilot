# Pattern: read an OData response in Groovy

Use this when a receiver URL contains `/odata/` or `.svc` and a script reads its response.

**Data shape**
- OData V2 JSON (`$format=json`): `{"d": {"results": [ ... ]}}`; some services return `{"d": [ ... ]}`, and a
  single entity is `{"d": { ... }}`.
- OData V4: `{"value": [ ... ]}`.
- Handle all of them, and an empty or missing list, without failing: read `json?.d`, then
  `d.results` (Map) or `d` (List), else `json?.value`, else `[]`.

**Values**
- V2 returns decimals as strings (`"UnitPrice": "18.0000"`); convert with
  `new BigDecimal(value.toString())` before comparing or calculating. Never compare the string.
- Dates in V2 are `"/Date(1696118400000)/"` (milliseconds since 1970).
- Every property can be null: skip null items and null values (`it != null && it.UnitPrice != null`).
  A null-unsafe `it.UnitPrice` on a missing item fails with "Cannot get property 'UnitPrice' on null object".

**Streaming**: parse the body with `new JsonSlurper().parse(message.getBody(java.io.Reader.class))`, never
`parseText(message.getBody(String))`.

**Example** (ran on CPI against the Northwind V2 service: products with a price above 20):

```groovy
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
```
