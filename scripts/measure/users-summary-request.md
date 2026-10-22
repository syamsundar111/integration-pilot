Create an iFlow.
Name: Users Summary RUNID
ID: Users_Summary_RUNID
Trigger: timer, run once after deployment.
Purpose: read users and their todos from a REST API, summarize the open todos per user and convert
the summary to XML for a reporting system.

Steps (in order):
1. Content Modifier "Set Properties", constant properties: sourceSystem = JSONPlaceholder,
   targetSystem = Reporting, reportName = Users Summary, environment = DEV,
   alertTo = alerts@example.com, alertFrom = noreply@example.com
2. Request-reply "Get Users": GET, receiver RCVR_Users, URL {{Users_URL}}, default
   https://jsonplaceholder.typicode.com/users
3. Content Modifier "Store Users": property UsersJson = expression ${in.body}
4. Request-reply "Get Todos": GET, receiver RCVR_Todos, URL {{Todos_URL}}, default
   https://jsonplaceholder.typicode.com/todos
5. Content Modifier "Store Todos": property TodosJson = expression ${in.body}
6. Groovy Script "Summarize Users":
   a. Parse the properties UsersJson and TodosJson as JSON arrays (an empty array if a property is
      missing or empty).
   b. Count the open todos per user: todos whose "completed" is false, grouped by "userId".
   c. For each user build an entry with id, name (trimmed), email (lower case), city
      (address.city, empty if missing) and openTodos (the count from b, 0 if none).
   d. Sort the entries by name.
   e. Set property UserCount to the number of entries.
   f. Set the body to JSON: {"report": <property reportName, default "Users Summary">,
      "count": <number of entries>, "users": [<entries>]}.
   g. Use groovy.json.JsonSlurper and JsonOutput, no other libraries; declare all variables with def.
7. JSON to XML Converter "Summary to XML"
No receiver at the end.
Error handling: exception subprocess "Exception Subprocess 1" with
- Content Modifier "Set Error Properties": ErrorMessage = expression ${exception.message},
  ErrorTimestamp = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
- Groovy Script "Build Error Message": set header Content-Type to text/plain and the body to four
  lines: "Report: <reportName>", "Environment: <environment>", "Time: <ErrorTimestamp>",
  "Error: <ErrorMessage>"; use "unknown" for a missing environment or error text.
Give every step a one-sentence description of its purpose.
