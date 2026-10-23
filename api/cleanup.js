const { cleanup } = require('../lib/store')

// Daily safety net (see crons in vercel.json); /generate also cleans up.
module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    res.status(401).send('Unauthorized')
    return
  }
  const removed = await cleanup()
  res.json({ removed })
}
