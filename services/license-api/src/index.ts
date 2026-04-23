import express from 'express';
import cors from 'cors';
import activateRouter from './routes/activate.js';
import heartbeatRouter from './routes/heartbeat.js';
import stripeRouter from './routes/stripe.js';
import adminRouter from './routes/admin.js';

const app = express();

// Stripe needs raw body for signature verification — must come before express.json()
app.use('/v1/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: ['https://gctrl.tech', 'https://admin.gctrl.tech'] }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'gctrl-api' }));

app.use(activateRouter);
app.use(heartbeatRouter);
app.use(stripeRouter);
app.use('/admin', adminRouter);

const PORT = process.env.PORT ?? 4000;
app.listen(PORT, () => console.log(`gctrl-api listening on :${PORT}`));
