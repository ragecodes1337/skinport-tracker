const express = require('express');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors()); // Enable CORS for all origins for testing

// A simple GET endpoint for testing
app.get('/test', (req, res) => {
    res.json({ message: 'Hello from Render Backend!' });
});

app.listen(port, () => {
    console.log(`[Server] Test API listening at http://localhost:${port}`);
});
