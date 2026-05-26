import express from 'express';
import routes from './routes.js';

const app = express();

app.use(routes)

app.listen('3344', () => {
  console.log('Server is running on port 3344');
});