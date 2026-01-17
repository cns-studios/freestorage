const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/content.db');

db.serialize(() => {
    db.run("ALTER TABLE peers ADD COLUMN free_storage_bytes INTEGER DEFAULT 0", (err) => {
        if (err) {
            console.log("Column might already exist or error:", err.message);
        } else {
            console.log("Column free_storage_bytes added successfully.");
        }
    });
});

db.close();