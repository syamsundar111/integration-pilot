Create an iFlow.
Name: Large Order Flow RUNID
ID: Large_Order_Flow_RUNID
Package: PilotReference
Trigger: HTTPS sender, address /pilot/large-order-RUNID
Authentication: no authentication on any receiver.
Purpose: receive a shop order (JSON), enrich it from several systems, send it to the ERP, notify
warehouse, CRM and audit, and answer the shop.

Steps (in order):
1. Content Modifier "Set Order Properties": property orderSource = constant Shop, property receivedAt = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}, property correlationId = expression ${header.X-Correlation-ID}
2. Groovy Script "Validate Order": parse the JSON body; throw an exception if orderId, customerId or a non-empty items list is missing; set property orderId.
3. Content Modifier "Store Original Order": property OriginalOrder = expression ${in.body}
4. Request-Reply "Get Customer": GET, receiver RCVR_Customer, URL {{CustomerAPI_URL}}, default https://httpbin.org/anything/customers
5. Content Modifier "Store Customer": property CustomerJson = expression ${in.body}
6. Request-Reply "Get Prices": GET, receiver RCVR_Prices, URL {{PriceAPI_URL}}, default https://httpbin.org/anything/prices
7. Content Modifier "Store Prices": property PricesJson = expression ${in.body}
8. Request-Reply "Get Stock": GET, receiver RCVR_Stock, URL {{StockAPI_URL}}, default https://httpbin.org/anything/stock
9. Content Modifier "Store Stock": property StockJson = expression ${in.body}
10. Groovy Script "Merge Order Data": merge the properties OriginalOrder, CustomerJson, PricesJson and StockJson into one JSON body with keys order, customer, prices, stock.
11. Groovy Script "Calculate Totals": for each item compute quantity x price (price from prices by item id, 0 if missing); net = sum, tax = 19 % of net, gross = net + tax, rounded to 2 decimals; add them to the body and set property OrderTotal = gross.
12. Content Modifier "Set Currency Headers": header Currency = constant EUR, header OrderTotal = expression ${property.OrderTotal}
13. JSON to XML Converter "Order to XML"
14. Groovy Script "Add ERP Envelope": wrap the XML body in a root element ERPOrder with attribute orderId from property orderId.
15. Content Modifier "Set ERP Headers": header Content-Type = constant application/xml, header SAP-Client = constant 100
16. Request-Reply "Post to ERP": POST, receiver RCVR_ERP, URL {{ERP_URL}}, default https://httpbin.org/anything/erp
17. Content Modifier "Store ERP Response": property ErpResponse = expression ${in.body}
18. Groovy Script "Read ERP Order Number": parse property ErpResponse as JSON; set property ErpOrderNumber from json.headers.X-Amzn-Trace-Id, or UNKNOWN if missing.
19. Content Modifier "Build Confirmation": body {"erpOrder":"${property.ErpOrderNumber}","total":"${property.OrderTotal}"}
20. Request-Reply "Notify Warehouse": POST, receiver RCVR_Warehouse, URL {{WarehouseAPI_URL}}, default https://httpbin.org/anything/warehouse
21. Content Modifier "Store Warehouse Response": property WarehouseResponse = expression ${in.body}
22. Request-Reply "Notify CRM": POST, receiver RCVR_CRM, URL {{CRM_URL}}, default https://httpbin.org/anything/crm
23. Content Modifier "Store CRM Response": property CrmResponse = expression ${in.body}
24. Groovy Script "Build Audit Record": body = JSON with orderId, erpOrderNumber, orderTotal, correlationId and the current UTC timestamp.
25. Request-Reply "Write Audit Log": POST, receiver RCVR_Audit, URL {{AuditAPI_URL}}, default https://httpbin.org/anything/audit
26. Content Modifier "Set Response Headers": header CamelHttpResponseCode = constant 201, header Content-Type = constant application/json
27. Content Modifier "Build Response Body": body {"status":"accepted","erpOrder":"${property.ErpOrderNumber}","total":"${property.OrderTotal}"}
28. Groovy Script "Set Summary": set property Summary = "order <orderId> accepted as <ErpOrderNumber>, total <OrderTotal>".
29. Content Modifier "Set Tracking Properties": property TrackingId = expression ${property.correlationId}
30. Groovy Script "Final Check": throw an exception if the body is empty.
No receiver at the end.
Error handling: exception subprocess with Content Modifier "Set Error Response": header CamelHttpResponseCode = constant 500, header Content-Type = constant application/json, body {"status":"failed","error":"${exception.message}"}
