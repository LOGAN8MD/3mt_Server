import express from 'express';
import { createUser, deleteUser, getUsers } from '../controllers/userController.js';
import { protect, isAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.use(protect, isAdmin);

router.route('/')
  .get(getUsers)
  .post(createUser);

router.delete('/:id', deleteUser);

export default router;
