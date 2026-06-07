const fs = require('fs');
const path = require('path');

function loadPrivateKeys() {
  const pkPath = path.join(__dirname, 'pk.txt');
  
  if (!fs.existsSync(pkPath)) {
    console.error('❌ pk.txt not found in project root!');
    console.error('   Please create pk.txt with one private key per line.');
    process.exit(1);
  }

  const content = fs.readFileSync(pkPath, 'utf8');
  
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
}

module.exports = { loadPrivateKeys };