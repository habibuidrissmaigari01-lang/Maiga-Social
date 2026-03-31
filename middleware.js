const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};

/**
 * Factory middleware to log and prevent Mass Assignment.
 * @param {string[]} allowedFields - Array of keys permitted in req.body
 */
const protectMassAssignment = (allowedFields) => {
    return (req, res, next) => {
        const incomingFields = Object.keys(req.body);
        const disallowed = incomingFields.filter(field => !allowedFields.includes(field));

        if (disallowed.length > 0) {
            disallowed.forEach(field => delete req.body[field]);
        }
        next();
    };
};

module.exports = { isAuthenticated, protectMassAssignment };
