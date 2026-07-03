const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// mock jwt.verify
jwt.verify = (token, secret, cb) => cb(null, { userId: 'admin-mock' });

const tradesRouter = require('./routes/trades');

const app = express();
app.use(express.json());
app.use('/api', tradesRouter);

const server = app.listen(4001, async () => {
  try {
    const res = await fetch('http://localhost:4001/api/stats?range=all', {
      headers: { 'Authorization': 'Bearer fake' }
    });
    const json = await res.json();
    console.log('STATUS:', res.status);
    console.log('RESPONSE:', JSON.stringify(json, null, 2));
    process.exit(0);
  } catch(e) {
    console.error(e);
    process.exit(1);
  }
});