const express = require("express");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const store = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [id, tx] of store) {
        if (now - tx.createdAt > 3600000) store.delete(id);
    }
}, 600000);

// ============================================================
//  Extract QRIS dari payment_number
//  Sandbox: "THIS.IS.JUST.AN.EXAMPLE.FOR.SANDBOX.00020101..."
//  Production: "00020101..."
// ============================================================
function extractQris(paymentNumber) {
    if (!paymentNumber || typeof paymentNumber !== "string") return null;

    // Langsung valid
    if (paymentNumber.startsWith("00020101")) {
        return paymentNumber;
    }

    // Sandbox mode — cari "00020101" di dalam string
    const idx = paymentNumber.indexOf("00020101");
    if (idx !== -1) {
        return paymentNumber.substring(idx);
    }

    return null;
}

// ============================================================
//  POST /api/create
// ============================================================
app.post("/api/create", async (req, res) => {
    try {
        const amount = parseInt(req.body.amount);

        if (!amount || isNaN(amount) || amount < 1000) {
            return res.json({ ok: false, error: "Minimal Rp 1.000" });
        }
        if (amount > 10000000) {
            return res.json({ ok: false, error: "Maksimal Rp 10.000.000" });
        }

        const orderId = `DP-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
        console.log(`\n[CREATE] ${orderId} | Rp ${amount.toLocaleString()}`);

        const apiRes = await fetch("https://app.pakasir.com/api/transactioncreate/qris", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                project: config.projectSlug,
                order_id: orderId,
                amount,
                api_key: config.apiKey
            })
        });

        const json = await apiRes.json();
        console.log("[API RESPONSE]", JSON.stringify(json, null, 2));

        const payment = json.payment;
        if (!payment || !payment.payment_number) {
            return res.json({ ok: false, error: "Gagal membuat QRIS", debug: json });
        }

        // Extract QRIS — handle sandbox prefix
        const qris = extractQris(payment.payment_number);

        if (!qris) {
            console.log("[ERROR] Tidak bisa extract QRIS dari:", payment.payment_number);
            return res.json({ ok: false, error: "QRIS string tidak valid" });
        }

        console.log(`[OK] QRIS: ${qris.substring(0, 50)}...`);
        console.log(`[OK] Total: Rp ${(payment.total_payment || amount).toLocaleString()} | Fee: ${payment.fee || 0}`);

        // Simpan
        store.set(orderId, {
            orderId,
            amount,
            totalPayment: payment.total_payment || amount,
            fee: payment.fee || 0,
            qris,
            status: "pending",
            createdAt: Date.now(),
            expiredAt: payment.expired_at
                ? new Date(payment.expired_at).getTime()
                : Date.now() + 300000
        });

        return res.json({
            ok: true,
            order_id: orderId,
            amount,
            total_payment: payment.total_payment || amount,
            fee: payment.fee || 0,
            qris,
            expired_at: payment.expired_at || null
        });

    } catch (e) {
        console.error("[ERROR]", e.message);
        return res.json({ ok: false, error: e.message });
    }
});

// ============================================================
//  POST /api/status
// ============================================================
app.post("/api/status", async (req, res) => {
    try {
        const { order_id, amount } = req.body;
        if (!order_id || !amount) return res.json({ ok: true, status: "pending" });

        const local = store.get(order_id);

        if (local && ["completed", "failed", "expired", "cancelled"].includes(local.status)) {
            return res.json({ ok: true, status: local.status });
        }

        if (local && Date.now() > local.expiredAt && local.status === "pending") {
            local.status = "expired";
            return res.json({ ok: true, status: "expired" });
        }

        const url = new URL("https://app.pakasir.com/api/transactiondetail");
        url.searchParams.set("project", config.projectSlug);
        url.searchParams.set("amount", String(amount));
        url.searchParams.set("order_id", order_id);
        url.searchParams.set("api_key", config.apiKey);

        const apiRes = await fetch(url.toString());
        const json = await apiRes.json();
        const tx = json.transaction || json;
        const status = (tx.status || "pending").toLowerCase();

        if (local && status !== "pending") {
            local.status = status;
            if (status === "completed") {
                console.log(`\n[💰 PAID] ${order_id} | Rp ${amount.toLocaleString()}`);
            }
        }

        return res.json({ ok: true, status });

    } catch (e) {
        return res.json({ ok: true, status: "pending" });
    }
});

// ============================================================
//  POST /api/webhook
// ============================================================
app.post("/api/webhook", (req, res) => {
    const body = req.body;
    console.log("\n[WEBHOOK]", JSON.stringify(body, null, 2));

    if (body.order_id && body.status) {
        const local = store.get(body.order_id);
        if (local && local.amount === body.amount) {
            local.status = body.status;
            console.log(`[WEBHOOK] ${body.order_id} → ${body.status}`);
        }
    }

    return res.json({ received: true });
});

// ============================================================
//  SPA Fallback
// ============================================================
app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
//  START
// ============================================================
app.listen(config.port, () => {
    console.log(`\n${"═".repeat(45)}`);
    console.log(`  💳 QRIS DEPOSIT`);
    console.log(`  http://localhost:${config.port}`);
    console.log(`  Project: ${config.projectSlug}`);
    console.log(`${"═".repeat(45)}\n`);
});