## Mail

A `sendMail` step sends a mail and the flow continues (a Send step, one-way): `{ "type": "sendMail", "name",
"system", "server": "smtp.example.com:587", "credentialName", "from", "to": "a@example.com, b@example.com",
"cc"?, "bcc"?, "subject", "body"? }`. `body` defaults to `${in.body}`, the message body. `server`,
`credentialName` and `to` can each be a whole `{{Param}}`. It always uses STARTTLS mandatory, Plain
User/Password and text/plain, without attachments; say so if the request needs something else. The
credential is the name of deployed User Credentials, never a password. It is allowed on the main line, in
routes, in local processes and in the exception subprocess (an alert mail on error).
