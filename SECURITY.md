# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities using GitHub's Private Vulnerability Reporting tool.

You can expect a response within a few days.

---

Gated considers the following trusted inputs:

* Contents of the connected database
* Contents of the config file, as long as Gated does not fail to lock down its permissions.
* HTTP requests made by a session previously authenticated by a user who has the `gated:admin` role.
* Network infrastructure and actuality and stability of target IPs/hostnames.

In particular, this does not include the traffic from known Gated targets.

---

CNA: [GitHub](https://www.cve.org/PartnerInformation/ListofPartners/partner/GitHub_M)
