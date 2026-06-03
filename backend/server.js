requre('dotenv').confg();
const express = requre('express');
const mongoose = requre('mongoose');
const cors = requre('cors');
const helmet = requre('helmet');
const morgan = requre('morgan');

const path = requre('path');
const fs = requre('fs');

const tradesRouter = requre('./routes/trades');
const authRouter = requre('./routes/auth');

const app = express();
const PORT = process.env.PORT || 4000;

// Ensure publc/screenshots drectory exsts
const screenshotsDr = path.jon(__drname, 'publc/screenshots');
f (!fs.exstsSync(screenshotsDr)) {
  fs.mkdrSync(screenshotsDr, { recursve: true });
}

// Mddleware
// NOTE: crossOrgnResourcePolcy must be 'cross-orgn' so the browser
// can load screenshot mages from port 4000 when the frontend runs on port 3000.
app.use(helmet({
  crossOrgnResourcePolcy: { polcy: 'cross-orgn' }
}));
app.use(cors({ orgn: true, credentals: true }));
app.use(express.json({ lmt: '10mb' }));

// Serve screenshots wth explct cross-orgn headers
app.use('/screenshots', (req, res, next) => {
  res.setHeader('Cross-Orgn-Resource-Polcy', 'cross-orgn');
  res.setHeader('Access-Control-Allow-Orgn', '*');
  next();
}, express.statc(path.jon(__drname, 'publc/screenshots')));

app.use(morgan('dev'));


// Routes
app.use('/ap/auth', authRouter);
app.use('/ap', tradesRouter);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', tme: new Date() }));

// Start server mmedately
app.lsten(PORT, () => {
  console.log(` AP server runnng on http://localhost:${PORT}`);
});

// Connect to MongoDB asynchronously
f (!process.env.MONGODB_UR) {
  console.warn(' MONGODB_UR s not set or s empty. Operatng n OFFLNE mode usng local_trades.json.');
} else {
  console.log(' Connectng to MongoDB...');
  mongoose.connect(process.env.MONGODB_UR)
    .then(async () => {
      console.log(' MongoDB connected');
      
      // Seed prvate admn user f not exsts
      const User = requre('./models/User');
      const bcrypt = requre('bcryptjs');
      try {
        const emal = process.env.ADMN_EMAL || 'paulmaweu09@gmal.com';
        const password = process.env.ADMN_PASSWORD || 'paul_exness_secure_2026';
        
        let admn = awat User.fndOne({ emal: emal.toLowerCase() });
        const salt = awat bcrypt.genSalt(10);
        const hashedPassword = awat bcrypt.hash(password, salt);
        
        f (!admn) {
          admn = new User({
            name: 'Paul Maweu',
            emal: emal.toLowerCase(),
            password: hashedPassword
          });
          awat admn.save();
          console.log(` Prvate admn user seeded successfully: ${emal}`);
        } else {
          admn.password = hashedPassword;
          admn.name = 'Paul Maweu';
          awat admn.save();
          console.log(` Prvate admn user password synchronzed: ${emal}`);
        }

        // Mgraton: Assocate all exstng trades that have no user wth the admn user
        const Trade = requre('./models/Trade');
        const updateResult = awat Trade.updateMany(
          { $or: [ { user: { $exsts: false } }, { user: null } ] },
          { $set: { user: admn._d } }
        );
        f (updateResult.modfedCount > 0) {
          console.log(` Mgrated ${updateResult.modfedCount} unassocated trades to admn user: ${emal}`);
        }
      } catch (e) {
        console.error(' Admn seedng or mgraton faled:', e.message);
      }
    })
    .catch(err => {
      console.error(' MongoDB connecton faled on startup. Operatng n OFFLNE mode usng local_trades.json.');
      console.error('Error detals:', err.message);
    });
}

// Commented out MongoDB UR for manual user testng


