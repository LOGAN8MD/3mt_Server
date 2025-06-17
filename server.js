import dotenv from 'dotenv';
dotenv.config();
import express from 'express';

import connectDB from './config/db.js';
import cors from 'cors';

import authRoutes from './routes/authRoutes.js';
import productRoutes from './routes/productRoutes.js';
import orderRoutes from './routes/orderRoutes.js';


connectDB();
const PORT = process.env.PORT || 8080;
const app = express();

app.use(cors());  // This allows your frontend to make requests to the backend
// app.use(cors({
//     origin: '*',  // For development, or specify 'http://localhost:3000' if restricted to the frontend
//     methods: ['GET', 'POST','DELETE','PUT'],
//     allowedHeaders: ['Content-Type', 'Authorization'],
//   }));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Routes
app.get('/pop',(req, res)=>{
    console.log("Running on Port 8080")
   
    res.send("Deepak 8080")
})

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);


app.listen(PORT, () => console.log(`Deepak Server running on port ${PORT}`));


// deepakmishra2327
// oHWYu8NaiFuBod8t
//password = Logan8md

// IP address (45.119.30.246)

