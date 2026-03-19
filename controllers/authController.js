// controllers/authController.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ---- Generate JWT ----
const generateToken = (userId) => {
  return jwt.sign(
    { id: userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

// ---- Format user for response ----
const formatUser = (user) => ({
  id: user._id,
  name: user.name,
  email: user.email,
  avatar: user.avatar || '',
  preferences: user.preferences || {},
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
});

const formatUserResponse = (user, token) => ({
  token,
  user: formatUser(user),
});

// ============================================
// SIGNUP
// ============================================
const signupUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide name, email, and password' });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ message: 'Name must be at least 2 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
    });

    const token = generateToken(user._id);
    return res.status(201).json(formatUserResponse(user, token));
  } catch (error) {
    console.error('Signup Error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0] });
    }
    if (error.code === 11000) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// LOGIN
// ============================================
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password' });
    }

    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = generateToken(user._id);
    return res.json(formatUserResponse(user, token));
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// GET ME
// ============================================
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ user: formatUser(user) });
  } catch (error) {
    console.error('GetMe Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// UPDATE PROFILE — FIXED: Uses findByIdAndUpdate
// (Avoids loading doc without password then calling .save())
// ============================================
const updateProfile = async (req, res) => {
  try {
    const { name, email, avatar } = req.body;
    const updateFields = {};

    // Validate and collect fields to update
    if (name !== undefined) {
      if (name.trim().length < 2) {
        return res.status(400).json({ message: 'Name must be at least 2 characters' });
      }
      updateFields.name = name.trim();
    }

    if (email !== undefined) {
      const normalizedEmail = email.toLowerCase().trim();

      // Check if email already taken by another user
      const existingUser = await User.findOne({
        email: normalizedEmail,
        _id: { $ne: req.user.id },
      });
      if (existingUser) {
        return res.status(409).json({ message: 'Email already in use' });
      }
      updateFields.email = normalizedEmail;
    }

    if (avatar !== undefined) {
      updateFields.avatar = avatar;
    }

    // Nothing to update
    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    // Use findByIdAndUpdate — does NOT trigger pre('save') or full validation
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({ user: formatUser(updatedUser) });
  } catch (error) {
    console.error('Update Profile Error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res.status(400).json({ message: messages[0] });
    }
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// UPDATE PREFERENCES — FIXED: Uses findByIdAndUpdate
// ============================================
const updatePreferences = async (req, res) => {
  try {
    const allowedFields = [
      'emailNotifications',
      'chatSounds',
      'darkMode',
      'language',
      'saveHistory',
      'showOnlineStatus',
    ];

    const updateFields = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateFields[`preferences.${field}`] = req.body[field];
      }
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ message: 'No valid preferences to update' });
    }

    // Use $set with dot notation — safe, no .save() needed
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { $set: updateFields },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      message: 'Preferences updated successfully',
      preferences: updatedUser.preferences,
    });
  } catch (error) {
    console.error('Update Preferences Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// GET PREFERENCES
// ============================================
const getPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ preferences: user.preferences || {} });
  } catch (error) {
    console.error('Get Preferences Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// CHANGE PASSWORD — FIXED: Uses select('+password') properly
// ============================================
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please provide current and new password' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: 'New password must be different' });
    }

    // Load user WITH password
    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }

    // Set new password — pre('save') hook will hash it
    user.password = newPassword;
    await user.save({ validateModifiedOnly: true });

    const token = generateToken(user._id);

    return res.json({ message: 'Password updated successfully', token });
  } catch (error) {
    console.error('Change Password Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// DELETE ACCOUNT
// ============================================
const deleteAccount = async (req, res) => {
  try {
    const { confirmation } = req.body;

    if (confirmation !== 'DELETE') {
      return res.status(400).json({ message: 'Please type DELETE to confirm' });
    }

    const result = await User.findByIdAndDelete(req.user.id);
    if (!result) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete Account Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

// ============================================
// EXPORT DATA
// ============================================
const exportData = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    return res.json({
      exportDate: new Date().toISOString(),
      exportVersion: '1.0',
      account: formatUser(user),
      preferences: user.preferences || {},
    });
  } catch (error) {
    console.error('Export Data Error:', error);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
};

module.exports = {
  signupUser,
  loginUser,
  getMe,
  updateProfile,
  updatePreferences,
  getPreferences,
  changePassword,
  deleteAccount,
  exportData,
};