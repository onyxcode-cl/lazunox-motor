// Se importa PRIMERO en ayudante-heredado.test.ts: el esquema de `task` se decide al cargar el módulo, así que la bandera
// tiene que estar puesta antes. Cada prueba la enciende o apaga en tiempo de ejecución con process.env.
process.env.LAZUNOX_AYUDANTE_HEREDADO = "1"
export {}
