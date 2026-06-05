require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const tradesRouter = require('./routes/trades');
const authRouter = require('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRouter);
app.use('/api', tradesRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// Start server immediately
app.listen(PORT, () => {
  console.log(` API server running on http://localhost:${PORT}`);
});

// Connect to MongoDB asynchronously
if (!process.env.MONGODB_URI) {
  console.warn(
    ' MONGODB_URI is not set or is empty. Operating in OFFLINE mode using local_trades.json.',
  );
} else {
  console.log(' Connecting to MongoDB...');
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      console.log(' MongoDB connected');

      // Seed private admin user if not exists
      const User = require('./models/User');
      const bcrypt = require('bcryptjs');
      try {
        const email = process.env.ADMIN_EMAIL;
        const password = process.env.ADMIN_PASSWORD;

        if (!email || !password) {
           console.warn(' ADMIN_EMAIL or ADMIN_PASSWORD not set. Admin seed skipped.');
           return;
        }

        let admin = await User.findOne({ email: email.toLowerCase() });
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        if (!admin) {
          admin = new User({
            name: 'Paul Maweu',
            email: email.toLowerCase(),
            password: hashedPassword,
          });
          await admin.save();
          console.log(` Private admin user seeded successfully: ${email}`);
        } else {
          admin.password = hashedPassword;
          admin.name = 'Paul Maweu';
          await admin.save();
          console.log(` Private admin user password synchronized: ${email}`);
        }

        // Migration: Associate all existing trades that have no user with the admin user
        const Trade = require('./models/Trade');
        const updateResult = await Trade.updateMany(
          { $or: [{ user: { $exists: false } }, { user: null }] },
          { $set: { user: admin._id } },
        );
        if (updateResult.modifiedCount > 0) {
          console.log(
            ` Migrated ${updateResult.modifiedCount} unassociated trades to admin user: ${email}`,
          );
        }
      } catch (e) {
        console.error(' Admin seeding or migration failed:', e.message);
      }
    })
    .catch((err) => {
      console.error(
        ' MongoDB connection failed on startup. Operating in OFFLINE mode using local_trades.json.',
      );
      console.error('Error details:', err.message);
    });
}
