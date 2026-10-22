import com.sap.gateway.ip.core.customdev.util.Message

/**
 * Plain-text error message for the alert: report name, environment, time and error text.
 */
def Message processData(Message message) {
    def lines = [
        "Report: ${message.getProperty('reportName') ?: 'Users Summary'}",
        "Environment: ${message.getProperty('environment') ?: 'unknown'}",
        "Time: ${message.getProperty('ErrorTimestamp') ?: ''}",
        "Error: ${message.getProperty('ErrorMessage') ?: 'unknown error'}"
    ]
    message.setHeader('Content-Type', 'text/plain')
    message.setBody(lines.join('\n'))
    return message
}
