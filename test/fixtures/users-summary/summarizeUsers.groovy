import com.sap.gateway.ip.core.customdev.util.Message
import groovy.json.JsonOutput
import groovy.json.JsonSlurper

/**
 * Summarizes the users (property UsersJson) with their open todos (property TodosJson):
 * one entry per user with id, name, email, city and the number of open todos, sorted by name.
 * Sets property UserCount and the body to the summary as JSON.
 */
def Message processData(Message message) {
    def slurper = new JsonSlurper()
    def users = slurper.parseText(message.getProperty('UsersJson') ?: '[]') ?: []
    def todos = slurper.parseText(message.getProperty('TodosJson') ?: '[]') ?: []

    def openTodos = [:].withDefault { 0 }
    todos.findAll { !it.completed }.each { openTodos[it.userId] += 1 }

    def summary = users.collect { u ->
        [
            id       : u.id,
            name     : (u.name ?: '').trim(),
            email    : (u.email ?: '').toLowerCase(),
            city     : u.address?.city ?: '',
            openTodos: openTodos[u.id]
        ]
    }.sort { it.name }

    message.setProperty('UserCount', String.valueOf(summary.size()))
    message.setBody(JsonOutput.toJson([report: message.getProperty('reportName') ?: 'Users Summary', count: summary.size(), users: summary]))
    return message
}
