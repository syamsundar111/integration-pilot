# Reference exports for receiver authentication and scheduled timers

Integration Pilot builds iFlow XML only from verified CPI exports. Two roadmap items need exports
that the tenant does not have yet:

- **Item 2, receiver authentication:** HTTP receivers with Basic, OAuth2 Client Credentials,
  OAuth2 SAML Bearer Assertion and Client Certificate, plus one with an externalized credential name.
- **Item 3, scheduled timers:** every N minutes, every N hours, daily, weekly and monthly, each in
  a time zone, plus one timer externalized as `{{Scheduler}}`.

Build the iFlows below in the CPI web editor exactly as listed, download them and put the zips in
`srv/iflow-builder/reference/`. Use the values as given: the builder templates are cut out of
these files, and the tests look for these names. The iFlows only need to be saved, not deployed.

All credential names below are dummy aliases. They do not need to exist in Security Material
(saving an iFlow does not check them). Never enter real credentials anywhere in these iFlows.

## 1. Create the test package

Use a separate package, not a client package.

1. *Design → Integrations and APIs → Create*.
2. Name: `Integration Pilot Reference Exports`
3. ID: `IntegrationPilot.ReferenceExports`
4. Short description: `Reference iFlows for Integration Pilot templates (no real credentials)`
5. *Save*.

Create every iFlow below in this package. For each one, the **Name and ID must both be the value
given**: the download is named after it.

## 2. Receiver authentication: `Reference_HttpAuth`

**Create:** *Add → Integration Flow*, Name and ID `Reference_HttpAuth`, then *OK*.

**Start event:**
1. Delete the default Sender and Start, and add *Events → Timer Start*.
2. Scheduler: *Run Once*.

**Main flow:** add six *Call → External Call → Request Reply* steps in a row, then the End event.
Connect each Request Reply to its own receiver with the *HTTP* adapter:

| # | Request Reply step name | Receiver (participant) name | Address | Method | Authentication | Credential |
|---|---|---|---|---|---|---|
| 1 | `Call None` | `REF_None` | `https://example.org/none` | GET | None | none |
| 2 | `Call Basic` | `REF_Basic` | `https://example.org/basic` | GET | Basic | Credential Name `REF_BASIC_CRED` |
| 3 | `Call OAuth CC` | `REF_OAuthCC` | `https://example.org/oauth-cc` | GET | OAuth2 Client Credentials | Credential Name `REF_OAUTH_CC` |
| 4 | `Call SAML` | `REF_SAML` | `https://example.org/saml` | GET | OAuth2 SAML Bearer Assertion | Credential Name `REF_SAML_CRED` |
| 5 | `Call Cert` | `REF_Cert` | `https://example.org/cert` | GET | Client Certificate | Private Key Alias `REF_CERT_ALIAS` |
| 6 | `Call Param` | `REF_Param` | `https://example.org/param` | GET | Basic | Credential Name **externalized** (see below) |

For receiver 6, select the Credential Name field and choose *Externalize*:
- parameter name `RefCredential`
- default value `REF_PARAM_CRED`

**End:** connect the End event to a seventh receiver:

| Receiver | Address | Method | Authentication | Credential |
|---|---|---|---|---|
| `REF_End` | `https://example.org/end` | POST | OAuth2 Client Credentials | Credential Name `REF_OAUTH_CC` |

Leave all other adapter fields at their defaults. *Save* (no need to deploy).

## 3. Scheduled timers: six iFlows

Each timer iFlow has the same shape:
1. Delete the default Sender and Start, and add *Events → Timer Start*.
2. Add one *Transformation → Content Modifier* named `Set Marker`, with one exchange property:
   name `Marker`, source type Constant, value `reference`.
3. Connect Timer Start → Set Marker → End.

Only the Timer Start settings differ. Use time zone **(UTC -5:00) Eastern Standard Time
(America/New_York)** in all six.

| iFlow name and ID | Timer Start → Scheduler settings |
|---|---|
| `Reference_Timer_Minutes` | *Schedule to Recur* → *Daily* → *Every* `15` *minutes*, between `00:00` and `24:00` |
| `Reference_Timer_Hours` | *Schedule to Recur* → *Daily* → *Every* `2` *hours*, between `00:00` and `24:00` |
| `Reference_Timer_Daily` | *Schedule to Recur* → *Daily* → *On Time* `06:30` |
| `Reference_Timer_Weekly` | *Schedule to Recur* → *Weekly* → days `Monday` and `Wednesday` → *On Time* `06:30` |
| `Reference_Timer_Monthly` | *Schedule to Recur* → *Monthly* → *On Day* `1` → *On Time* `06:30` |
| `Reference_Timer_Externalized` | *Schedule to Recur* → *Daily* → *On Time* `06:30`, then *Externalize* the scheduler as parameter `Scheduler` |

*Save* each one (no need to deploy).

## 4. Download the zips

For each of the seven iFlows:

1. Open the package `Integration Pilot Reference Exports`, tab *Artifacts*.
2. In the iFlow's row choose *Actions (⋯) → Download*. If CPI asks, choose *Default Values Only*
   or *Merged Configured and Default Values*; both are fine because nothing is configured yet.
3. The browser saves `<iFlow ID>.zip`. If the file has another name, rename it to the iFlow ID.

## 5. Put them in the project

Copy the seven zips into `srv/iflow-builder/reference/`. The existing `Reference_AllSteps.zip` and
`Reference_Timer.zip` stay.

| File | For |
|---|---|
| `Reference_HttpAuth.zip` | item 2 |
| `Reference_Timer_Minutes.zip` | item 3 |
| `Reference_Timer_Hours.zip` | item 3 |
| `Reference_Timer_Daily.zip` | item 3 |
| `Reference_Timer_Weekly.zip` | item 3 |
| `Reference_Timer_Monthly.zip` | item 3 |
| `Reference_Timer_Externalized.zip` | item 3 |

Check before handing over:

- Seven new zips in `srv/iflow-builder/reference/`, each named exactly as above.
- No real passwords, keys or tokens in any iFlow; only the dummy aliases above.
- The iFlows are saved in `IntegrationPilot.ReferenceExports`. Deploying them is not needed, and
  the package can stay on the tenant as a reference.

Then tell the assistant the exports are in place. Items 2 and 3 are built from them, with tests that
compare the builder output against these files.
