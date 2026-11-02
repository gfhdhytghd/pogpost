# LAN operator WebUI

Current workstation URL: `http://172.16.105.62:8788/console`.

The separate `sealed-notes-lan.service` binds only the selected 172.16 interface and forwards an explicit console/debug/overlay route list to the existing loopback service. Connections must come directly from the same /24 subnet, use the exact LAN Host, and provide either no Origin or the exact same Origin. Public/forwarded requests are refused. Existing operator cookie and action-header checks still run upstream. The gateway translates only validated LAN Host/Origin headers into the loopback origin.

The gateway does not expose extension credentials, OAuth/setup endpoints, viewer EBS APIs, or `POST /api/events/trigger`. An explicit action allowlist admits the existing console controls. Debug and perception state are not changed by enabling the LAN listener. No Twitch broadcast is started.

Implementation: `tools/lan-webui.mjs`. Unit verification: `node --test test/lan-webui.test.js`. The forwarding test uses an isolated mocked LAN peer and local dummy upstream. A real local browser check at the LAN URL loaded the operator console and its quick controls; this does not prove reachability from a different device.

Manage with `systemctl --user status|stop|start sealed-notes-lan.service`. The service starts on login. The IPv4 address comes from DHCP; update the service's `--host` address if the workstation address changes. The original `127.0.0.1:8788` application and its public relay rules remain separate.
