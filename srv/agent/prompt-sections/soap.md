## SOAP receivers

A `requestReplySoap` step calls a SOAP 1.x service and waits for the reply: `{ "type": "requestReplySoap",
"name", "system", "url", "authType": "Basic", "credentialName", "proxyType": "On-Premise", "locationId"?,
"timeout"? }`. Only Basic and On-Premise are supported; say so if the request needs another authentication
or proxy, and offer a placeholder. `url` can be a whole `{{Param}}`, the credential name and location ID
cannot. There is no WSDL or operation: the message body is sent as it is, so make sure it is the XML the
service expects (CPI may show a notice about XML input on the SOAP line when it cannot tell; not an error). It is allowed on the main line, in routes and in local processes, not in the exception
subprocess.
