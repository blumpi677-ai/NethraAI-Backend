const Contact = require('../models/Contact');

// ============================================
// VALIDATION HELPERS
// ============================================

const VALID_CATEGORIES = [
  'general', 'sales', 'support', 'partnership',
  'enterprise', 'feedback', 'bug', 'feature',
];

const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

// Basic profanity / spam patterns
const SPAM_PATTERNS = [
  /\b(viagra|cialis|casino|lottery|winner|congratulations.*won)\b/i,
  /\b(click here|buy now|limited time|act now|free money)\b/i,
  /\b(nigerian prince|inheritance|million dollars)\b/i,
  /(https?:\/\/.*){4,}/i, // 4+ URLs = likely spam
  /(.)\1{10,}/i, // 10+ repeated characters
];

// Disposable email domains
const DISPOSABLE_DOMAINS = [
  'tempmail.com', 'throwaway.email', 'guerrillamail.com',
  'mailinator.com', 'yopmail.com', 'sharklasers.com',
  'guerrillamailblock.com', 'grr.la', 'dispostable.com',
  'tempail.com', 'temp-mail.org', 'fakeinbox.com',
  'maildrop.cc', 'trashmail.com', '10minutemail.com',
];

/**
 * Validates and sanitizes a single field.
 * Returns { valid, value, error }
 */
const validateField = (name, value, rules) => {
  // Trim string values
  const trimmed = typeof value === 'string' ? value.trim() : value;

  // Required check
  if (rules.required && (!trimmed || trimmed.length === 0)) {
    return {
      valid: false,
      value: trimmed,
      error: `${rules.label || name} is required`,
    };
  }

  // Skip further validation if optional and empty
  if (!rules.required && (!trimmed || trimmed.length === 0)) {
    return { valid: true, value: '', error: null };
  }

  // Min length
  if (rules.minLength && trimmed.length < rules.minLength) {
    return {
      valid: false,
      value: trimmed,
      error: `${rules.label || name} must be at least ${rules.minLength} characters`,
    };
  }

  // Max length
  if (rules.maxLength && trimmed.length > rules.maxLength) {
    return {
      valid: false,
      value: trimmed,
      error: `${rules.label || name} cannot exceed ${rules.maxLength} characters`,
    };
  }

  // Pattern
  if (rules.pattern && !rules.pattern.test(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      error: rules.patternMessage || `${rules.label || name} is invalid`,
    };
  }

  // Enum
  if (rules.enum && !rules.enum.includes(trimmed)) {
    return {
      valid: false,
      value: trimmed,
      error: `${rules.label || name} must be one of: ${rules.enum.join(', ')}`,
    };
  }

  return { valid: true, value: trimmed, error: null };
};

/**
 * Validates the entire form data.
 * Returns { isValid, errors, sanitized }
 */
const validateContactForm = (body) => {
  const errors = {};
  const sanitized = {};

  // ---- Name ----
  const nameResult = validateField('name', body.name, {
    label: 'Name',
    required: true,
    minLength: 2,
    maxLength: 100,
    pattern: /^[a-zA-ZÀ-ÿ\s'\-\.]+$/,
    patternMessage: 'Name contains invalid characters',
  });
  if (!nameResult.valid) errors.name = nameResult.error;
  sanitized.name = nameResult.value;

  // ---- Email ----
  const emailResult = validateField('email', body.email, {
    label: 'Email',
    required: true,
    maxLength: 254,
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    patternMessage: 'Please provide a valid email address',
  });
  if (!emailResult.valid) {
    errors.email = emailResult.error;
  } else if (emailResult.value) {
    // Check disposable email
    const domain = emailResult.value.split('@')[1]?.toLowerCase();
    if (DISPOSABLE_DOMAINS.includes(domain)) {
      errors.email = 'Please use a non-disposable email address';
    }
  }
  sanitized.email = emailResult.value?.toLowerCase() || '';

  // ---- Company ----
  const companyResult = validateField('company', body.company, {
    label: 'Company',
    required: false,
    maxLength: 100,
  });
  if (!companyResult.valid) errors.company = companyResult.error;
  sanitized.company = companyResult.value || '';

  // ---- Subject ----
  const subjectResult = validateField('subject', body.subject, {
    label: 'Subject',
    required: true,
    minLength: 3,
    maxLength: 200,
  });
  if (!subjectResult.valid) errors.subject = subjectResult.error;
  sanitized.subject = subjectResult.value;

  // ---- Category ----
  const categoryResult = validateField('category', body.category, {
    label: 'Category',
    required: true,
    enum: VALID_CATEGORIES,
  });
  if (!categoryResult.valid) errors.category = categoryResult.error;
  sanitized.category = categoryResult.value;

  // ---- Priority ----
  const priorityResult = validateField('priority', body.priority || 'normal', {
    label: 'Priority',
    required: false,
    enum: VALID_PRIORITIES,
  });
  if (!priorityResult.valid) errors.priority = priorityResult.error;
  sanitized.priority = priorityResult.value || 'normal';

  // ---- Message ----
  const messageResult = validateField('message', body.message, {
    label: 'Message',
    required: true,
    minLength: 10,
    maxLength: 2000,
  });
  if (!messageResult.valid) {
    errors.message = messageResult.error;
  } else if (messageResult.value) {
    // Spam check
    for (const pattern of SPAM_PATTERNS) {
      if (pattern.test(messageResult.value)) {
        errors.message = 'Your message was flagged as potential spam. Please revise it.';
        break;
      }
    }
  }
  sanitized.message = messageResult.value;

  // Also check subject for spam
  if (sanitized.subject) {
    for (const pattern of SPAM_PATTERNS) {
      if (pattern.test(sanitized.subject)) {
        errors.subject = 'Subject contains potentially spammy content';
        break;
      }
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    sanitized,
  };
};

// ============================================
// RATE LIMITING (in-memory, per IP)
// ============================================
const rateLimitMap = new Map();

const checkRateLimit = (ip) => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxSubmissions = 5; // 5 per 15 minutes

  const entry = rateLimitMap.get(ip);

  if (!entry) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: maxSubmissions - 1 };
  }

  // Window expired — reset
  if (now - entry.firstRequest > windowMs) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return { allowed: true, remaining: maxSubmissions - 1 };
  }

  // Within window
  if (entry.count >= maxSubmissions) {
    const retryAfter = Math.ceil((entry.firstRequest + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }

  entry.count++;
  return { allowed: true, remaining: maxSubmissions - entry.count };
};

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.firstRequest > windowMs) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Clean every 5 minutes

// ============================================
// SUBMIT CONTACT FORM
// POST /api/contact
// ============================================
const submitContactForm = async (req, res) => {
  try {
    // ---- Rate limiting ----
    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      'unknown';

    const rateCheck = checkRateLimit(clientIp);

    if (!rateCheck.allowed) {
      return res.status(429).json({
        message: `Too many submissions. Please try again in ${rateCheck.retryAfter} seconds.`,
        retryAfter: rateCheck.retryAfter,
      });
    }

    // ---- Validate ----
    const { isValid, errors, sanitized } = validateContactForm(req.body);

    if (!isValid) {
      return res.status(400).json({
        message: 'Validation failed',
        errors,
      });
    }

    // ---- Check for duplicate submission (same email + message in last 5 min) ----
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const duplicate = await Contact.findOne({
      email: sanitized.email,
      message: sanitized.message,
      createdAt: { $gte: fiveMinutesAgo },
    });

    if (duplicate) {
      return res.status(409).json({
        message: 'This message was already submitted recently. Please wait before sending again.',
      });
    }

    // ---- Create contact entry ----
    const contact = await Contact.create({
      ...sanitized,
      ipAddress: clientIp,
      userAgent: req.headers['user-agent'] || '',
      userId: req.user?.id || null, // If authenticated
    });

    console.log(
      `📬 New contact submission [${contact.category}/${contact.priority}]: ` +
      `${contact.name} <${contact.email}> — "${contact.subject}"`
    );

    // ---- Response ----
    return res.status(201).json({
      message: 'Your message has been sent successfully!',
      submission: {
        id: contact._id,
        name: contact.name,
        email: contact.email,
        subject: contact.subject,
        category: contact.category,
        priority: contact.priority,
        createdAt: contact.createdAt,
      },
      remaining: rateCheck.remaining,
    });
  } catch (error) {
    console.error('Contact Form Error:', error);

    if (error.name === 'ValidationError') {
      const messages = {};
      for (const [key, val] of Object.entries(error.errors)) {
        messages[key] = val.message;
      }
      return res.status(400).json({
        message: 'Validation failed',
        errors: messages,
      });
    }

    return res.status(500).json({
      message: 'Failed to submit your message. Please try again.',
    });
  }
};

// ============================================
// GET ALL CONTACTS (Admin)
// GET /api/contact
// ============================================
const getContacts = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      status,
      category,
      priority,
      search,
      sort = '-createdAt',
    } = req.query;

    const filter = {};

    if (status) filter.status = status;
    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { subject: { $regex: search, $options: 'i' } },
        { message: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [contacts, total] = await Promise.all([
      Contact.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Contact.countDocuments(filter),
    ]);

    return res.json({
      contacts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Get Contacts Error:', error);
    return res.status(500).json({ message: 'Failed to load contacts' });
  }
};

// ============================================
// GET SINGLE CONTACT (Admin)
// GET /api/contact/:id
// ============================================
const getContact = async (req, res) => {
  try {
    const contact = await Contact.findById(req.params.id);

    if (!contact) {
      return res.status(404).json({ message: 'Contact submission not found' });
    }

    // Mark as read if new
    if (contact.status === 'new') {
      contact.status = 'read';
      await contact.save();
    }

    return res.json({ contact });
  } catch (error) {
    console.error('Get Contact Error:', error);
    return res.status(500).json({ message: 'Failed to load contact' });
  }
};

// ============================================
// UPDATE CONTACT STATUS (Admin)
// PUT /api/contact/:id
// ============================================
const updateContact = async (req, res) => {
  try {
    const { status, adminNotes } = req.body;
    const updates = {};

    if (status) {
      const validStatuses = ['new', 'read', 'in-progress', 'resolved', 'closed'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      updates.status = status;
      if (status === 'resolved') {
        updates.resolvedAt = new Date();
      }
    }

    if (adminNotes !== undefined) {
      updates.adminNotes = adminNotes.trim().slice(0, 1000);
    }

    const contact = await Contact.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    );

    if (!contact) {
      return res.status(404).json({ message: 'Contact submission not found' });
    }

    return res.json({ contact });
  } catch (error) {
    console.error('Update Contact Error:', error);
    return res.status(500).json({ message: 'Failed to update contact' });
  }
};

// ============================================
// DELETE CONTACT (Admin)
// DELETE /api/contact/:id
// ============================================
const deleteContact = async (req, res) => {
  try {
    const result = await Contact.findByIdAndDelete(req.params.id);

    if (!result) {
      return res.status(404).json({ message: 'Contact submission not found' });
    }

    return res.json({ message: 'Contact deleted successfully' });
  } catch (error) {
    console.error('Delete Contact Error:', error);
    return res.status(500).json({ message: 'Failed to delete contact' });
  }
};

// ============================================
// GET CONTACT STATS (Admin)
// GET /api/contact/stats
// ============================================
const getContactStats = async (req, res) => {
  try {
    const [
      totalCount,
      statusCounts,
      categoryCounts,
      priorityCounts,
      recentCount,
    ] = await Promise.all([
      Contact.countDocuments(),
      Contact.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Contact.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
      Contact.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Contact.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }),
    ]);

    const toMap = (arr) =>
      arr.reduce((acc, { _id, count }) => ({ ...acc, [_id]: count }), {});

    return res.json({
      total: totalCount,
      last24h: recentCount,
      byStatus: toMap(statusCounts),
      byCategory: toMap(categoryCounts),
      byPriority: toMap(priorityCounts),
    });
  } catch (error) {
    console.error('Contact Stats Error:', error);
    return res.status(500).json({ message: 'Failed to load stats' });
  }
};

module.exports = {
  submitContactForm,
  getContacts,
  getContact,
  updateContact,
  deleteContact,
  getContactStats,
};