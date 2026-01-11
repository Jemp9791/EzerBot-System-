// src/modules/roles/roleService.js

const config = require("../config/configService");

async function getRole(phone) {
  const vendedores = await config.list("TelefonosVendedores");
  const admins = await config.list("TelefonosAdmins");

  if (admins.includes(phone)) return "ADMIN";
  if (vendedores.includes(phone)) return "VENDEDOR";
  return "CLIENTE";
}

module.exports = {
  getRole,
};
