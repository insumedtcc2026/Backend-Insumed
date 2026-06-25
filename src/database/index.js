import knexLib from 'knex';
import knexfile from '../../knexfile.js';

const knex = knexLib(knexfile.development);

export default knex;