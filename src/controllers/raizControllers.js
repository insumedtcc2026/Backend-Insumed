
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class RaizController {
  index(req, res) {
    try {
      const caminhoDoArquivo = path.resolve(__dirname, '../../public/index.html');
      
      return res.sendFile(caminhoDoArquivo);
    } catch (error) {
      return res.status(500).json({ erro: "Falha ao carregar a documentação." });
    }
  }
}

export default new RaizController();