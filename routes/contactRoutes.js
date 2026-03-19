const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  submitContactForm,
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  getContactStats,
} = require('../controllers/contactController');

// ============================================
// PUBLIC — anyone can submit
// ============================================
router.post('/', submitContactForm);

// ============================================
// PROTECTED — admin routes
// (In production, add an admin middleware)
// ============================================
router.get('/', protect, getContacts);
router.get('/stats', protect, getContactStats);
router.get('/:id', protect, getContact);
router.put('/:id', protect, updateContact);
router.delete('/:id', protect, deleteContact);

module.exports = router;