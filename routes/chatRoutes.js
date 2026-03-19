const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getConversations,
  getConversation,
  deleteConversation,
  sendMessage,
  renameConversation,
  enhancePrompt,
  translateText,       // ← ADD
} = require('../controllers/chatController');

router.use(protect);

router.get('/conversations', getConversations);
router.get('/conversations/:id', getConversation);
router.delete('/conversations/:id', deleteConversation);
router.post('/send', sendMessage);
router.put('/conversations/:id/rename', renameConversation);
router.post('/enhance', enhancePrompt);
router.post('/translate', translateText);   // ← ADD

module.exports = router;