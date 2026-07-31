const express = require("express");
const axios = require("axios");
const https = require("https");

const app = express();
const PORT = 3000;

app.set("view engine", "ejs");
app.use(express.urlencoded({ extended: true }));

// --- Config ---------------------------------------------------------------
const PVE_HOST = "https://10.13.4.253:8006";
const PVE_USER = process.env.PVE_USER || "root@pam";
const PVE_PASS = process.env.PVE_PASS || "tfsrun@7"; // move this to an env var, don't leave real creds in source
const STORAGE = process.env.PVE_STORAGE || "local-lvm"; // set to whatever storage pool you actually have
const BRIDGE = process.env.PVE_BRIDGE || "vmbr0";
const ISO_STORAGE = process.env.PVE_ISO_STORAGE || "local"; // storage where your ISO images live

const agent = new https.Agent({
    rejectUnauthorized: false, // self-signed cert on the PVE host
});

// --- Small helper so every render() call always has every template var ----
const defaultLocals = { stats: null, vm: null, deleted: null, error: null, isos: [], vms: [], node: null };
function renderIndex(res, overrides = {}) {
    res.render("index", { ...defaultLocals, ...overrides });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Auth: POST /api2/json/access/ticket -> ticket + CSRF token ----------
async function getAuthTicket() {
    const res = await axios.post(
        `${PVE_HOST}/api2/json/access/ticket`,
        new URLSearchParams({ username: PVE_USER, password: PVE_PASS }),
        { httpsAgent: agent }
    );
    return {
        ticket: res.data.data.ticket,
        csrfToken: res.data.data.CSRFPreventionToken,
    };
}

// --- GET /api2/json/nodes -> first node name in the cluster ---------------
async function getFirstNode(ticket) {
    const res = await axios.get(`${PVE_HOST}/api2/json/nodes`, {
        httpsAgent: agent,
        headers: { Cookie: `PVEAuthCookie=${ticket}` },
    });
    return res.data.data[0].node;
}

// --- GET /api2/json/cluster/nextid -> next free VMID -----------------------
async function getNextVmid(ticket) {
    const res = await axios.get(`${PVE_HOST}/api2/json/cluster/nextid`, {
        httpsAgent: agent,
        headers: { Cookie: `PVEAuthCookie=${ticket}` },
    });
    return res.data.data;
}

// --- GET /api2/json/nodes/{node}/tasks/{upid}/status -> task state --------
async function getTaskStatus(ticket, node, upid) {
    const res = await axios.get(
        `${PVE_HOST}/api2/json/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`,
        {
            httpsAgent: agent,
            headers: { Cookie: `PVEAuthCookie=${ticket}` },
        }
    );
    return res.data.data;
}

// Poll a task until it's no longer running, or give up after maxAttempts
async function waitForTask(ticket, node, upid, maxAttempts = 20, delayMs = 1000) {
    for (let i = 0; i < maxAttempts; i++) {
        const status = await getTaskStatus(ticket, node, upid);
        if (status.status === "stopped") return status;
        await sleep(delayMs);
    }
    throw new Error(`Task ${upid} did not finish within ${(maxAttempts * delayMs) / 1000}s`);
}

// --- GET /api2/json/nodes/{node}/storage/{storage}/content?content=iso ----
async function listIsos(ticket, node, isoStorage) {
    const res = await axios.get(
        `${PVE_HOST}/api2/json/nodes/${node}/storage/${isoStorage}/content`,
        {
            httpsAgent: agent,
            headers: { Cookie: `PVEAuthCookie=${ticket}` },
            params: { content: "iso" },
        }
    );
    // volid looks like "local:iso/debian-13.0.0-amd64-netinst.iso"
    return (res.data.data || []).map((item) => ({
        volid: item.volid,
        name: item.volid.split("/").pop(),
        size: item.size,
    }));
}

// Pick a specific ISO by volid if requested and available, else the first one found
function pickIso(isos, preferredVolid) {
    if (!isos.length) {
        throw new Error(`No ISO images found on storage "${ISO_STORAGE}"`);
    }
    if (preferredVolid) {
        const match = isos.find((i) => i.volid === preferredVolid);
        if (match) return match;
    }
    return isos[0];
}

// --- GET /api2/json/nodes/{node}/qemu -> list VMs on the node --------------
async function listVms(ticket, node) {
    const res = await axios.get(`${PVE_HOST}/api2/json/nodes/${node}/qemu`, {
        httpsAgent: agent,
        headers: { Cookie: `PVEAuthCookie=${ticket}` },
    });
    return (res.data.data || []).sort((a, b) => a.vmid - b.vmid);
}

// --- POST /api2/json/nodes/{node}/qemu/{vmid}/status/stop ------------------
async function stopVm(ticket, node, vmid, csrfToken) {
    const res = await axios.post(
        `${PVE_HOST}/api2/json/nodes/${node}/qemu/${vmid}/status/stop`,
        new URLSearchParams({}),
        {
            httpsAgent: agent,
            headers: {
                Cookie: `PVEAuthCookie=${ticket}`,
                CSRFPreventionToken: csrfToken,
            },
        }
    );
    return res.data.data; // upid
}

// --- DELETE /api2/json/nodes/{node}/qemu/{vmid} ----------------------------
async function deleteVm(ticket, node, vmid, csrfToken) {
    const res = await axios.delete(`${PVE_HOST}/api2/json/nodes/${node}/qemu/${vmid}`, {
        httpsAgent: agent,
        headers: {
            Cookie: `PVEAuthCookie=${ticket}`,
            CSRFPreventionToken: csrfToken,
        },
        params: { purge: 1 }, // also clean up backup-job/pool/HA references
    });
    return res.data.data; // upid
}

// --- Routes -----------------------------------------------------------------
app.get("/", async (req, res) => {
    let isos = [];
    let vms = [];
    let node = null;
    try {
        const { ticket } = await getAuthTicket();
        node = await getFirstNode(ticket);
        isos = await listIsos(ticket, node, ISO_STORAGE);
        vms = await listVms(ticket, node);
    } catch (_) {
        // If PVE is unreachable at page load, just show empty lists;
        // the POST routes below will surface the real error if it still can't connect.
    }
    renderIndex(res, { isos, vms, node });
});

app.post("/stats", async (req, res) => {
    try {
        const { ticket, csrfToken } = await getAuthTicket();
        renderIndex(res, { stats: { ticket, csrfToken } });
    } catch (err) {
        renderIndex(res, { error: err.message });
    }
});

// POST /api2/json/nodes/{node}/qemu -> create a 2-core / 2GB RAM / 32GB disk VM
// with an ISO attached as install media (req.body.iso lets the form pick a
// specific volid; otherwise the first ISO found on ISO_STORAGE is used).
app.post("/create-vm", async (req, res) => {
    try {
        const { ticket, csrfToken } = await getAuthTicket();
        const node = await getFirstNode(ticket);
        const vmid = await getNextVmid(ticket);

        const isos = await listIsos(ticket, node, ISO_STORAGE);
        const iso = pickIso(isos, req.body.iso);

        const params = new URLSearchParams({
            vmid: String(vmid),
            name: `vm-${vmid}`,
            cores: "2",
            sockets: "1",
            memory: "2048", // MB -> 2 GB RAM
            cpu: "host",
            scsihw: "virtio-scsi-pci",
            scsi0: `${STORAGE}:32`, // 32 GB disk
            net0: `virtio,bridge=${BRIDGE}`,
            ide2: `${iso.volid},media=cdrom`, // attach the ISO as a virtual CD/DVD
            ostype: "l26",
            boot: "order=ide2;scsi0", // boot the installer first, then fall back to disk
            agent: "1",
        });

        const createRes = await axios.post(
            `${PVE_HOST}/api2/json/nodes/${node}/qemu`,
            params,
            {
                httpsAgent: agent,
                headers: {
                    Cookie: `PVEAuthCookie=${ticket}`,
                    CSRFPreventionToken: csrfToken,
                },
            }
        );

        const upid = createRes.data.data; // e.g. "UPID:node:...:qmcreate:vmid:user:"
        let taskStatus = null;
        try {
            taskStatus = await getTaskStatus(ticket, node, upid);
        } catch (_) {
            // creation may still be running; ignore a failed immediate check
        }

        const vms = await listVms(ticket, node);
        renderIndex(res, { vm: { vmid, node, iso: iso.volid, upid, taskStatus }, isos, vms, node });
    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        renderIndex(res, { error: detail });
    }
});

// POST /api2/json/nodes/{node}/qemu/{vmid} (DELETE) -> remove a VM
// Stops the VM first if it's running, since Proxmox refuses to delete a running VM.
app.post("/delete-vm", async (req, res) => {
    try {
        const { ticket, csrfToken } = await getAuthTicket();
        const node = await getFirstNode(ticket);
        const vmid = req.body.vmid;

        if (!vmid) {
            throw new Error("No VM selected to delete");
        }

        const vms = await listVms(ticket, node);
        const target = vms.find((v) => String(v.vmid) === String(vmid));
        if (!target) {
            throw new Error(`VMID ${vmid} not found on node ${node}`);
        }

        if (target.status === "running") {
            const stopUpid = await stopVm(ticket, node, vmid, csrfToken);
            await waitForTask(ticket, node, stopUpid);
        }

        const deleteUpid = await deleteVm(ticket, node, vmid, csrfToken);
        const taskStatus = await waitForTask(ticket, node, deleteUpid);

        const isos = await listIsos(ticket, node, ISO_STORAGE);
        const remainingVms = await listVms(ticket, node);

        renderIndex(res, {
            deleted: { vmid, node, taskStatus },
            isos,
            vms: remainingVms,
            node,
        });
    } catch (err) {
        const detail = err.response ? JSON.stringify(err.response.data) : err.message;
        renderIndex(res, { error: detail });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});