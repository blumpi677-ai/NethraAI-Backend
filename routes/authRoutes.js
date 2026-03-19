const express = require('express');
const router = express.Router();
const {
  signupUser,
  loginUser,
  getMe,
  updateProfile,
  updatePreferences,
  getPreferences,
  changePassword,
  deleteAccount,
  exportData,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// ---- Public ----
router.post('/signup', signupUser);
router.post('/login', loginUser);

// ---- Protected ----
router.get('/me', protect, getMe);

// Profile
router.put('/profile', protect, updateProfile);

// Preferences
router.get('/preferences', protect, getPreferences);
router.put('/preferences', protect, updatePreferences);

// Security
router.put('/password', protect, changePassword);

// Account management
router.delete('/account', protect, deleteAccount);
router.get('/export', protect, exportData);

module.exports = router;