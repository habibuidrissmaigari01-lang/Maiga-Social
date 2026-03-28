const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
    identity: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    type: { type: String, enum: ['registration', 'password_reset'], required: true },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 600 }
});

// Ensure uniqueness for an identity per type (e.g., one registration code at a time)
otpSchema.index({ identity: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('Otp', otpSchema);