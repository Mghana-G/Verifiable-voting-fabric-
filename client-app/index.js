'use strict';

const express = require('express');

const verifyRoute = require('./routes/verify');
const mintRoute   = require('./routes/mint');
const castRoute   = require('./routes/cast');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/verify', verifyRoute);
app.use('/mint',   mintRoute);
app.use('/cast',   castRoute);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
    console.log(`client-app listening on port ${PORT}`);
});

module.exports = app;
