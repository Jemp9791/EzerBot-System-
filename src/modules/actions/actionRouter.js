const userState = require("../state/userStateService");

function execute(action, phone) {
  if (!action) return;

  const [type, value] = action.split(":");

  switch (type) {
    case "NAVIGATE":
      userState.setStage(phone, value);
      return value;

    case "ACTION":
      return value;

    default:
      return null;
  }
}

module.exports = { execute };
