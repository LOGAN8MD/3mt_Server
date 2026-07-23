import 'dotenv/config';
import express from 'express';

import connectDB from './config/db.js';
import cors from 'cors';

import authRoutes from './routes/authRoutes.js';
import productRoutes from './routes/productRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import userRoutes from './routes/userRoutes.js';
import pendingProductRoutes from './routes/pendingProductRoutes.js';
import enquiryRoutes from './routes/enquiryRoutes.js';
import errorHandler from './middlewares/errorMiddleware.js';
import AppError from './utils/AppError.js';


connectDB();
const PORT = process.env.PORT || 8080;
const app = express();

app.set('trust proxy', 1);

const defaultAllowedOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'https://3mt-machine-tools.netlify.app',
    'https://3mt-dashboard.netlify.app',
];

const allowedOrigins = (process.env.CLIENT_URLS || defaultAllowedOrigins.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new AppError('Not allowed by CORS', 403));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH' ,'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static('uploads'));

// Routes
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        service: '3mt-server',
        timestamp: new Date().toISOString(),
    });
});

app.get('/pop', (req, res) => {
    res.send("Server running")
})

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/pending-products', pendingProductRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/enquiries', enquiryRoutes);

// Global Error Handler
app.use(errorHandler);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
