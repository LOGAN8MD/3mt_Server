import express from 'express';
import {
  createUser,
  deleteUser,
  getMyProfile,
  getUsers,
  updateUserRole,
  updateMyProfile,
} from '../controllers/userController.js';
import { protect, isAdmin } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.route('/me')
  .get(protect, getMyProfile)
  .put(protect, updateMyProfile);

router.use(protect, isAdmin);

router.route('/')
  .get(getUsers)
  .post(createUser);

router.patch('/:id/role', updateUserRole);
router.delete('/:id', deleteUser);

export default router;
