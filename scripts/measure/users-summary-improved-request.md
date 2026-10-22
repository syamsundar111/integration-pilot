Create an iFlow.
Name: Users Summary RUNID
ID: Users_Summary_RUNID
Purpose: read users and their todos from a REST API, summarize the open todos per user and convert
the summary to XML for a reporting system.
Steps (in order):
1. Content Modifier "Set Properties", constant properties:
   sourceSystem = JSONPlaceholder, targetSystem = Reporting, reportName = Users Summary,
   environment = DEV, alertTo = alerts@example.com, alertFrom = noreply@example.com
2. Request-reply "Get Users": GET, receiver RCVR_Users, URL {{Users_URL}}, default
   https://jsonplaceholder.typicode.com/users
3. Content Modifier "Store Users": property UsersJson = expression ${in.body}
4. Request-reply "Get Todos": GET, receiver RCVR_Todos, URL {{Todos_URL}}, default
   https://jsonplaceholder.typicode.com/todos
5. Content Modifier "Store Todos": property TodosJson = expression ${in.body}
6. Groovy Script "Summarize Users" using the attached summarizeUsers.groovy
7. JSON to XML Converter "Summary to XML"
No receiver at the end.
Error handling: exception subprocess "Exception Subprocess 1" with
- Content Modifier "Set Error Properties": ErrorMessage = expression ${exception.message},
  ErrorTimestamp = expression ${date:now:yyyy-MM-dd'T'HH:mm:ss}
- Groovy Script "Build Error Message" using the attached buildErrorMessage.groovy
Give every step a one-sentence description of its purpose.
