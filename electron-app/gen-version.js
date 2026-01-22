const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

try {
    const rev = execSync('git rev-parse --short HEAD').toString().trim();
    const date = new Date().toISOString().split('T')[0];
    const versionData = {
        version: require('./package.json').version,
        hash: rev,
        buildDate: date,
        display: `${require('./package.json').version}-${rev}`
    };
    fs.writeFileSync(path.join(__dirname, 'version.json'), JSON.stringify(versionData, null, 2));
    console.log(`Generated version.json: ${versionData.display}`);
} catch (e) {
    console.error('Could not generate git version, using package.json version only.');
}
