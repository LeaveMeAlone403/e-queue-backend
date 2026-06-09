const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 8080;

// Мідлвари
app.use(cors());
app.use(express.json());

// ==========================================
// 🗄️ НАЛАШТУВАННЯ ТА ІНІЦІАЛІЗАЦІЯ БАЗИ ДАНИХ
// ==========================================
const db = new sqlite3.Database('./database.db');

// Промісифікація методів SQLite для зручного async/await
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});

const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});

// Створення таблиць та початкове заповнення (Seed)
const initDB = async () => {
    try {
        // 1. Таблиця користувачів (Колонка password тепер обов'язкова)
        await dbRun(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                last_name TEXT NOT NULL,
                first_name TEXT NOT NULL,
                middle_name TEXT,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL
            )
        `);

        // 2. Таблиця слотів розкладу
        await dbRun(`
            CREATE TABLE IF NOT EXISTS slots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                time TEXT NOT NULL,
                isBooked INTEGER DEFAULT 0
            )
        `);

        // 3. Таблиця бронювань (Талонів)
        await dbRun(`
            CREATE TABLE IF NOT EXISTS bookings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                slot_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                service TEXT NOT NULL,
                FOREIGN KEY (slot_id) REFERENCES slots(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        // 👥 Генерація тестових користувачів (якщо таблиця порожня)
        // const userCheck = await dbGet(`SELECT COUNT(*) as count FROM users`);
        // if (userCheck.count === 0) {
        //     await dbRun(
        //         `INSERT INTO users (last_name, first_name, middle_name, email, password) VALUES (?, ?, ?, ?, ?)`,
        //         ['Петренко', 'Олександр', 'Олегович', 'alex.petrenko@gmail.com', '1234']
        //     );
        //     await dbRun(
        //         `INSERT INTO users (last_name, first_name, middle_name, email, password) VALUES (?, ?, ?, ?, ?)`,
        //         ['Іванов', 'Іван', 'Іванович', 'ivan@gmail.com', 'qwerty']
        //     );
        //     console.log('🟢 Тестові користувачі успішно створені!');
        // }

        // 📅 Автоматична генерація слотів на сьогодні та наступні 5 днів (якщо порожньо)
        const slotCheck = await dbGet(`SELECT COUNT(*) as count FROM slots`);
        if (slotCheck.count === 0) {
            const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30'];

            for (let i = 0; i < 6; i++) {
                const d = new Date();
                d.setDate(d.getDate() + i);
                const dateStr = d.toISOString().split('T')[0]; // Формат YYYY-MM-DD

                for (const time of times) {
                    await dbRun(`INSERT INTO slots (date, time, isBooked) VALUES (?, ?, 0)`, [dateStr, time]);
                }
            }
            console.log('🟢 Сітку талонів на 6 днів згенеровано!');
        }

    } catch (err) {
        console.error('Помилка ініціалізації бази даних:', err);
    }
};
initDB();


// ==========================================
// 🌐 ЕНДПОІНТИ API
// ==========================================

// 🕒 1. Отримання розкладу слотів на вибрану дату
app.get('/api/schedule', async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Параметр date обовʼязковий' });

    try {
        const query = `
            SELECT 
                s.id, s.time,
                CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END as isBooked,
                (u.last_name || ' ' || u.first_name || ' ' || u.middle_name) as clientName,
                b.service
            FROM slots s
            LEFT JOIN bookings b ON s.id = b.slot_id
            LEFT JOIN users u ON b.user_id = u.id
            WHERE s.date = ? ORDER BY s.time ASC
        `;
        const rows = await dbAll(query, [date]);
        res.json(rows.map(r => ({
            ...r,
            isBooked: !!r.isBooked,
            clientName: r.clientName?.trim() || null
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🚗 2. Бронювання слоту (з верифікацією Email + Пароль)
app.post('/api/book', async (req, res) => {
    const { slotId, email, password, service } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Логін (Email) та пароль обовʼязкові для верифікації!' });
    }

    try {
        // Крок 1: Шукаємо користувача в базі за поштою та паролем
        const user = await dbGet(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Неправильний email або пароль!' });
        }

        // Крок 2: Перевіряємо чи вільний слот
        const slot = await dbGet(`SELECT * FROM slots WHERE id = ?`, [slotId]);
        if (!slot) return res.status(404).json({ error: 'Обраний слот не знайдено в базі даних.' });
        if (slot.isBooked) return res.status(400).json({ error: 'Цей час уже кимось заброньовано!' });

        // Крок 3: Створюємо запис бронювання
        const result = await dbRun(
            `INSERT INTO bookings (slot_id, user_id, service) VALUES (?, ?, ?)`,
            [slotId, user.id, service]
        );

        // Крок 4: Маркуємо слот як зайнятий
        await dbRun(`UPDATE slots SET isBooked = 1 WHERE id = ?`, [slotId]);

        // Повертаємо сформований талон на фронтенд
        res.json({
            success: true,
            id: result.lastID, // Номер талона
            time: slot.time,
            date: slot.date,
            service: service,
            clientName: `${user.last_name} ${user.first_name} ${user.middle_name || ''}`.trim()
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 📝 Реєстрація нового користувача (Клієнта)
app.post('/api/register', async (req, res) => {
    const { last_name, first_name, middle_name, email, password } = req.body;

    // Базова перевірка на бекенді
    if (!last_name || !first_name || !email || !password) {
        return res.status(400).json({ error: 'Заповніть усі обовʼязкові поля!' });
    }

    try {
        // Перевіряємо, чи не зайнятий email
        const existingUser = await dbGet(`SELECT id FROM users WHERE email = ?`, [email.trim()]);
        if (existingUser) {
            return res.status(400).json({ error: 'Користувач з таким Email вже існує!' });
        }

        // Додаємо нового користувача в базу
        const result = await dbRun(
            `INSERT INTO users (last_name, first_name, middle_name, email, password) VALUES (?, ?, ?, ?, ?)`,
            [last_name.trim(), first_name.trim(), middle_name?.trim() || '', email.trim(), password]
        );

        res.json({
            success: true,
            message: 'Реєстрація успішна! Тепер ви можете увійти.',
            userId: result.lastID
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🛠️ Ізольований вхід для Адміністратора
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;

    // Перевіряємо захардкоджені дані на сервері (можеш змінити на свій смак)
    if (email === 'admin' && password === 'admin') {
        return res.json({
            success: true,
            message: 'Ласкаво просимо в панель керування, Шеф!'
        });
    }

    // Якщо у формі вводиться admin@example.com (як у твоєму placeholder)
    if (email === 'admin@example.com' && password === 'admin') {
        return res.json({
            success: true,
            message: 'Ласкаво просимо в панель керування, Шеф!'
        });
    }

    // Якщо дані не збігаються — даємо відсіч
    return res.status(401).json({ error: 'Невірний логін або пароль адміністратора!' });
});

// ❌ 3. Скасування запису за номером талона (з верифікацією Email + Пароль)
app.post('/api/cancel', async (req, res) => {
    const { ticketNumber, email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Введіть ваші Email та Пароль у блоці авторизації для скасування талона!' });
    }

    try {
        // Крок 1: Верифікація користувача
        const user = await dbGet(`SELECT id FROM users WHERE email = ? AND password = ?`, [email, password]);
        if (!user) {
            return res.status(401).json({ error: 'Автентифікація провалена. Неправильний email або пароль!' });
        }

        // Крок 2: Перевірка чи існує талон і чи належить він саме цьому юзеру
        const booking = await dbGet(`SELECT * FROM bookings WHERE id = ? AND user_id = ?`, [ticketNumber, user.id]);
        if (!booking) {
            return res.status(404).json({ error: 'Талон не знайдено!' });
        }

        // Крок 3: Звільняємо слот в розкладі
        await dbRun(`UPDATE slots SET isBooked = 0 WHERE id = ?`, [booking.slot_id]);

        // Крок 4: Видаляємо запис про бронювання
        await dbRun(`DELETE FROM bookings WHERE id = ?`, [ticketNumber]);

        res.json({ success: true, message: `Талон №${ticketNumber} успішно скасовано. Час знову вільний!` });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 👥 4. Адмінський ендпоінт для списку користувачів
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await dbAll(`SELECT id, last_name, first_name, middle_name, email FROM users ORDER BY last_name ASC`);
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ❌ 6. Видалення користувача та очищення його записів
// ❌ Старий перевірений ендпоінт видалення користувача
app.post('/api/admin/delete-user', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'ID користувача обовʼязковий!' });

    try {
        // 1. Спочатку видаляємо всі бронювання цього користувача, щоб звільнити слоти клієнтам
        await dbRun(`DELETE FROM bookings WHERE user_id = ?`, [userId]);

        // 2. Видаляємо самого користувача з таблиці users
        await dbRun(`DELETE FROM users WHERE id = ?`, [userId]);

        res.json({ success: true, message: 'Користувача та всі його активні талони успішно видалено!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🛠️ Перемикач для адміна (ВИПРАВЛЕНИЙ)
app.post('/api/admin/toggle', async (req, res) => {
    const { slotId } = req.body;
    try {
        const booking = await dbGet(`SELECT id FROM bookings WHERE slot_id = ?`, [slotId]);

        if (booking) {
            // Якщо слот вже заблокований або заброньований — видаляємо запис (звільняємо слот)
            await dbRun(`DELETE FROM bookings WHERE slot_id = ?`, [slotId]);

            // Також оновлюємо статус самого слоту, щоб він став вільним
            await dbRun(`UPDATE slots SET isBooked = 0 WHERE id = ?`, [slotId]);

            res.json({ success: true, status: 'freed' });
        } else {
            // Якщо слот вільний — адмін його блокує
            let adminUser = await dbGet(`SELECT id FROM users WHERE email = 'admin@mreo.gov.ua'`);
            let adminId;

            if (adminUser) {
                adminId = adminUser.id;
            } else {
                // ✅ ВИПРАВЛЕНО: Додано стовпець password та його значення, щоб задовольнити NOT NULL constraint
                const result = await dbRun(
                    `INSERT INTO users (last_name, first_name, middle_name, email, password) VALUES (?, ?, ?, ?, ?)`,
                    ['Адмін', 'МРЕО', '—', 'admin@mreo.gov.ua', 'admin1234']
                );
                adminId = result.lastID;
            }

            // Створюємо адмінське бронювання
            await dbRun(`INSERT INTO bookings (slot_id, user_id, service) VALUES (?, ?, 'Адмін-бронь')`, [slotId, adminId]);

            // Маркуємо слот у таблиці slots як зайнятий
            await dbRun(`UPDATE slots SET isBooked = 1 WHERE id = ?`, [slotId]);

            res.json({ success: true, status: 'blocked' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 📊 СТОРІНКА ВІЗУАЛІЗАЦІЇ БАЗИ ДАНИХ (БРАУЗЕР)
// ==========================================
app.get('/db-view', async (req, res) => {
    try {
        const users = await dbAll(`SELECT id, last_name, first_name, middle_name, email, password FROM users`);
        const bookings = await dbAll(`SELECT * FROM bookings`);
        const slots = await dbAll(`SELECT * FROM slots WHERE isBooked = 1`);

        let html = `
            <html>
            <head>
                <title>Database View</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 40px; background: #f8fafc; color: #334155; }
                    table { border-collapse: collapse; width: 100%; margin-bottom: 35px; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); borderRadius: 8px; overflow: hidden; }
                    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #e2e8f0; }
                    th { background: #0f172a; color: white; font-weight: 600; }
                    tr:hover { background: #f1f5f9; }
                    h2 { color: #1e293b; border-left: 5px solid #3b82f6; padding-left: 10px; }
                    .pass-tag { background: #e0e7ff; color: #4338ca; padding: 4px 8px; borderRadius: 4px; font-family: monospace; font-weight: bold; }
                </style>
            </head>
            <body>
                <h1>📊 Поточний стан бази даних SQLite</h1>
                <p>Використовуйте ці дані на фронтенді для перевірки авторизації дій.</p>
                
                <h2>👥 Користувачі (таблиця: users)</h2>
                <table>
                    <tr>
                        <th>ID</th>
                        <th>Прізвище</th>
                        <th>Ім'я</th>
                        <th>По-батькові</th>
                        <th>Email (Логін)</th>
                        <th>Пароль (Для ClientPage)</th>
                    </tr>
        `;

        users.forEach(u => {
            html += `
                <tr>
                    <td><b>${u.id}</b></td>
                    <td>${u.last_name}</td>
                    <td>${u.first_name}</td>
                    <td>${u.middle_name || '—'}</td>
                    <td><mark>${u.email}</mark></td>
                    <td><span class="pass-tag">${u.password}</span></td>
                </tr>
            `;
        });

        html += `</table><h2>📅 Активні бронювання (таблиця: bookings / Талони)</h2><table>
                    <tr>
                        <th>Номер талона (ID)</th>
                        <th>ID Слоту</th>
                        <th>ID Користувача</th>
                        <th>Обрана послуга</th>
                    </tr>`;

        bookings.forEach(b => {
            html += `
                <tr>
                    <td><span style="color: #ef4444; font-weight: bold;">№ ${b.id}</span></td>
                    <td>${b.slot_id}</td>
                    <td>${b.user_id}</td>
                    <td><b>${b.service}</b></td>
                </tr>
            `;
        });

        html += `</table><h2>🔒 Зайняті слоти (таблиця: slots)</h2><table>
                    <tr>
                        <th>ID Слоту</th>
                        <th>Дата</th>
                        <th>Час</th>
                        <th>Статус</th>
                    </tr>`;

        slots.forEach(s => {
            html += `
                <tr>
                    <td>${s.id}</td>
                    <td>${s.date}</td>
                    <td>${s.time}</td>
                    <td><span style="color: #b91c1c; font-weight: bold;">🔒 Зайнято</span></td>
                </tr>
            `;
        });

        html += `</table></body></html>`;
        res.send(html);
    } catch (err) {
        res.status(500).send("Помилка завантаження бази даних: " + err.message);
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 Сервер черги МРЕО запущено на http://localhost:${PORT}`);
    console.log(`📊 Перегляд бази даних: http://localhost:${PORT}/db-view`);
    console.log(`===================================================`);
});