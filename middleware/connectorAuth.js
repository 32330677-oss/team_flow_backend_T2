const crypto = require('crypto');

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();

module.exports = (req, res, next) => {
  const expected = process.env.ATTENDANCE_CONNECTOR_TOKEN;
  if (!expected || expected.length < 32) {
    return res.status(503).json({ status: 'error', message: 'Connector authentication is not configured.' });
  }
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!crypto.timingSafeEqual(sha(provided), sha(expected))) {
    return res.status(401).json({ status: 'error', message: 'Invalid connector token.' });
  }
  req.isConnector = true;
  next();
};