const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

module.exports = function (req, res, next) {
  // Get token from header
  const authHeader = req.header('Authorization');

  // Check if no token
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token, authorization denied' });
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'JWT_SECRET is not configured' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Offline login tokens intentionally use a non-ObjectId placeholder. Once
    // MongoDB reconnects they must be replaced by a normal owner login token;
    // otherwise every owner-scoped query fails with a Mongoose CastError.
    if (mongoose.connection.readyState === 1 && !mongoose.Types.ObjectId.isValid(String(decoded.userId || ''))) {
      return res.status(401).json({ error: 'Your offline session expired after MongoDB reconnected. Please sign in again.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Token is not valid' });
  }
};
