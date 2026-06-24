import express from 'express';
import {
  getProducts,
  searchProducts,
  getRelatedProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/productController.js';
import { protect, isAdmin } from '../middlewares/authMiddleware.js';
import { upload } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

router.get('/', getProducts);
router.get('/search', searchProducts);
router.get('/:id/related', getRelatedProducts);
router.get('/:id', getProductById);
router.post('/', protect, isAdmin, upload.array('images', 5), createProduct);
router.put('/:id', protect, isAdmin, upload.array('images', 5), updateProduct);
router.delete('/:id', protect, isAdmin, deleteProduct);

export default router;
