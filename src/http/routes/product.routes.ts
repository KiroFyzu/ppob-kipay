import { Router } from 'express';
import { z } from 'zod';
import { BRANDS, Brand } from '../../domain/enums';
import * as productService from '../../modules/products/product.service';
import { asyncHandler, ok } from '../helpers';

export const productRouter = Router();

/**
 * Katalog bersifat publik: frontend perlu menampilkan harga sebelum user login.
 * Harga modal tidak pernah ikut dikirim (lihat product.service.ts).
 */

productRouter.get(
  '/brands',
  asyncHandler(async (_req, res) => {
    ok(res, await productService.listBrands());
  }),
);

const listQuerySchema = z.object({
  brand: z
    .string()
    .transform((v) => v.toUpperCase())
    .refine((v): v is Brand => (BRANDS as string[]).includes(v), {
      message: `brand harus salah satu dari: ${BRANDS.join(', ')}`,
    })
    .optional(),
});

productRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { brand } = listQuerySchema.parse(req.query);
    const products = await productService.listProducts({ ...(brand ? { brand } : {}) });
    ok(res, { count: products.length, products });
  }),
);
