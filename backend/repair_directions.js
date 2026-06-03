require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const LOCAL_DB_PATH = path.join(__dirname, 'local_trades.json');

// 1. Repair local persistent JSON database
function repairLocalJson() {
  try {
    if (fs.existsSync(LOCAL_DB_PATH)) {
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      const trades = JSON.parse(raw);
      
      let correctedCount = 0;
      const repaired = trades.map(t => {
        const original = t.direction;
        let corrected = original;
        if (original === 'BUY') {
          corrected = 'SELL';
        } else if (original === 'SELL') {
          corrected = 'BUY';
        }
        
        if (corrected !== original) {
          correctedCount++;
        }
        
        return {
          ...t,
          direction: corrected
        };
      });

      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(repaired, null, 2), 'utf8');
      console.log(`✅ Repaired local JSON database: Inverted direction for ${correctedCount} trades.`);
    } else {
      console.log('ℹ️ No local persistent JSON database found to repair.');
    }
  } catch (err) {
    console.error('❌ Failed to repair local JSON database:', err.message);
  }
}

// 2. Repair MongoDB database
async function repairMongo() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.log('ℹ️ No MONGODB_URI found in env. Skipping MongoDB direction repair.');
    return;
  }

  try {
    console.log('🔄 Connecting to MongoDB to repair trade directions...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB.');

    const Trade = require('./models/Trade');
    const allTrades = await Trade.find({});
    console.log(`Fetched ${allTrades.length} trades from MongoDB.`);

    let correctedCount = 0;
    for (const trade of allTrades) {
      const original = trade.direction;
      let corrected = original;
      if (original === 'BUY') {
        corrected = 'SELL';
      } else if (original === 'SELL') {
        corrected = 'BUY';
      }

      if (corrected !== original) {
        trade.direction = corrected;
        await trade.save();
        correctedCount++;
      }
    }

    console.log(`✅ Repaired MongoDB database: Inverted direction for ${correctedCount} trades.`);
  } catch (err) {
    console.error('❌ Failed to repair MongoDB database:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB.');
  }
}

// Run repairs
async function run() {
  repairLocalJson();
  await repairMongo();
  console.log('🎉 Direction repair process finished!');
}

run();
