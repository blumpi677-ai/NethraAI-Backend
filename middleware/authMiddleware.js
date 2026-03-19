// middleware/authMiddleware.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  try {
    let token;

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer')) {
      token = authHeader.split(' ')[1];
    }

    // No token
    if (!token || token === 'null' || token === 'undefined') {
      return res.status(401).json({ message: 'Not authorized. No token provided.' });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      // Always return 401 for token issues so frontend knows to log out
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ message: 'Token expired. Please log in again.' });
      }
      return res.status(401).json({ message: 'Invalid token. Please log in again.' });
    }

    // Find user
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists.' });
    }

    req.user = { id: user._id, name: user.name, email: user.email };
    next();
  } catch (error) {
    console.error('Auth Middleware Error:', error);
    // Return 500, NOT 401 — so frontend doesn't log the user out
    return res.status(500).json({ message: 'Authentication error. Please try again.' });
  }
};

module.exports = { protect };