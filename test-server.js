const express = require('express');
const path = require('path');
const app = express();
const port = 5176;

console.log("Attempting to serve static files from:", path.join(__dirname, 'public'));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, () => {
  console.log(`✅ Barebones test server running at http://localhost:${port}` );
  console.log("Go to http://localhost:5176/style.css in your browser." );
});
